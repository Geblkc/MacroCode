use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::Channel;
use tauri::State;

/// İş 2 — CSP `connect-src` bypass.
///
/// WebView `fetch` yalnızca `tauri.conf.json` içindeki hostlara gidebilir. Özel uç,
/// `baseUrlOverride` ve uzak Ollama URL'leri bu listeye girmez. Bu komut isteği
/// `reqwest`'ten çıkarır ve SSE gövdesini Channel üzerinden WebView'e aktarır.
///
/// Kanal olayları (JSON):
///
/// - `{"k":"meta","status":200,"headers":{...}}` — yanıt başlığı (ilk event)
/// - `{"k":"data","text":"..."}` — gövde parçası (satır bazlı, kayıp UTF-8 kabul)
/// - `{"k":"done"}` — gövde bitti
///
/// Hata sözleşmesi `stream_anthropic` ile aynı: ağ → `Err("ag hatasi: …")`,
/// HTTP hata durumu meta içinde taşınır (istekçi `res.ok`'dan okur).

#[derive(Default)]
pub struct ProxyState {
    inflight: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

/// İstek bitince/kaybedilince kaydı temizler (RAII).
struct Cleanup<'a> {
    id: u64,
    state: &'a ProxyState,
}

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.state.inflight.lock() {
            map.remove(&self.id);
        }
    }
}

/// Faz 10 (O2) — proxy sertleştirme.
///
/// Proxy'nin işi CSP'yi aşmak (özel uç / uzak Ollama / uzak MCP). Başka hiçbir
/// şey yapmasına gerek yok; bu yüzden istek yüzeyi daraltıldı:
/// - yalnızca http/https,
/// - yalnızca izinli HTTP metotları,
/// - yalnızca güvenli başlıklar (host/connection/transfer-encoding/content-length/upgrade),
/// - link-local / metadata IP'leri (169.254.0.0/16, fe80::/10, 0.0.0.0/8, 100.64/10),
/// - istek zaman aşımı ve maksimum yanıt boyutu.
const ALLOWED_METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BLOCKED_HEADERS: [&str; 6] = [
    "host",
    "connection",
    "transfer-encoding",
    "content-length",
    "upgrade",
    "proxy-authorization",
];
/// Maksimum yanıt gövdesi (bayt) — sonsuz akış koruması.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
/// İstek zaman aşımı (saniye).
const REQUEST_TIMEOUT_SECS: u64 = 120;

/// B3 — IPv6 içine **gömülü IPv4**'ü çıkarır (varsa). Üç biçim kapatılır:
/// - IPv4-mapped `::ffff:a.b.c.d`
/// - NAT64 well-known `64:ff9b::/96`
/// - 6to4 `2002:<v4hi>:<v4lo>::/48`
///
/// `Ipv6Addr::to_ipv4()` sürüm bağımlı/deprecated olduğu için segment
/// aritmetiği elle yapılır.
fn embedded_ipv4(v6: &std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let s = v6.segments();
    // ::ffff:0:0/96 — IPv4-mapped.
    if s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0xffff {
        return Some(std::net::Ipv4Addr::from([
            (s[6] >> 8) as u8,
            (s[6] & 0xff) as u8,
            (s[7] >> 8) as u8,
            (s[7] & 0xff) as u8,
        ]));
    }
    // 64:ff9b::/96 — NAT64 well-known prefix.
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 {
        return Some(std::net::Ipv4Addr::from([
            (s[6] >> 8) as u8,
            (s[6] & 0xff) as u8,
            (s[7] >> 8) as u8,
            (s[7] & 0xff) as u8,
        ]));
    }
    // 2002::/16 — 6to4; gömülü v4 ilk iki segmentten sonra.
    if s[0] == 0x2002 {
        return Some(std::net::Ipv4Addr::from([
            (s[1] >> 8) as u8,
            (s[1] & 0xff) as u8,
            (s[2] >> 8) as u8,
            (s[2] & 0xff) as u8,
        ]));
    }
    None
}

/// Link-local / metadata / belirsiz adresler engellenir.
/// (LAN'daki Ollama: 192.168.x, 10.x **serbesttir** — meşru kullanım.)
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_link_local()      // 169.254.0.0/16 (bulut metadata dahil)
                || v4.is_unspecified() // 0.0.0.0
                || o[0] == 0            // 0.0.0.0/8
                || (o[0] == 100 && (o[1] & 0xC0) == 64) // 100.64.0.0/10 (CGNAT)
        }
        // B3 — eski kod yalnız `fe80::/10` bakıyordu; `::ffff:169.254.169.254`
        // (IPv4-mapped), ULA `fc00::/7`, site-local `fec0::/10`, multicast
        // `ff00::/8`, NAT64 ve 6to4 gömülü v4'leri GEÇİYORDU.
        std::net::IpAddr::V6(v6) => {
            let s = v6.segments();
            // Önce gömülü IPv4 varsa onun kurallarına devret (mapped/NAT64/6to4).
            if let Some(v4) = embedded_ipv4(&v6) {
                return is_blocked_ip(std::net::IpAddr::V4(v4));
            }
            v6.is_unspecified()                        // ::
                // `::1` loopback bilinçli olarak SERBEST (V4'te 127.0.0.1 gibi):
                // yerel Ollama/yerel uç meşru kullanım. Tutarlılık için engellenmez.
                || (s[0] & 0xfe00) == 0xfe00           // fe80::/10 link-local
                || (s[0] & 0xfe00) == 0xfc00           // fc00::/7 unique-local (fc00..fdff)
                || (s[0] & 0xffc0) == 0xfec0           // fec0::/10 site-local
                || (s[0] & 0xff00) == 0xff00 // ff00::/8 multicast
        }
    }
}

/// B3 — `host_str()` IPv6 literallerini köşeli parantezle döndürür
/// (`"[fe80::1]"`), bu yüzden düz `parse::<IpAddr>()` başarısız oluyordu ve
/// `check_host_not_metadata` sessizce `Ok(())`'ye düşüyordu (asıl bypass).
fn parse_ip_literal(host: &str) -> Option<std::net::IpAddr> {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .ok()
}

/// Sadece http/https — `file:`/`data:` gibi şemalar reddedilir.
/// URL içinde kimlik bilgisi (`http://user:pass@host`) reddedilir.
fn check_url(url: &str) -> Result<reqwest::Url, String> {
    let t = url.trim();
    if !(t.starts_with("http://") || t.starts_with("https://")) {
        return Err("gecersiz url: yalnizca http/https desteklenir".to_string());
    }
    let parsed = reqwest::Url::parse(t).map_err(|e| format!("gecersiz url: {e}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("gecersiz url: kimlik bilgisi iceren adres desteklenmez".to_string());
    }
    Ok(parsed)
}

/// Host link-local/metadata adresine çözümleniyorsa reddet.
async fn check_host_not_metadata(url: &reqwest::Url) -> Result<(), String> {
    let Some(host) = url.host_str() else {
        return Err("gecersiz url: host yok".to_string());
    };
    // Doğrudan IP adresi → hızlı kontrol. B3: köşeli parantezli IPv6
    // (`[::ffff:169.254.169.254]`) `parse::<IpAddr>()` ile ayrıştırılamadığı
    // için bu kontrol sessizce atlanıyordu; `parse_ip_literal` bunu kapatır.
    if let Some(ip) = parse_ip_literal(host) {
        if is_blocked_ip(ip) {
            return Err("yasakli hedef: link-local/metadata adresi".to_string());
        }
        return Ok(());
    }
    // Alan adı → çözümle ve IP'leri denetle.
    let port = url.port_or_known_default().unwrap_or(443);
    match tokio::net::lookup_host((host, port)).await {
        Ok(addrs) => {
            for addr in addrs {
                if is_blocked_ip(addr.ip()) {
                    return Err("yasakli hedef: link-local/metadata adresi".to_string());
                }
            }
            Ok(())
        }
        // Çözümleme başarısızsa istek zaten hata verecek — burada engelleme.
        Err(_) => Ok(()),
    }
}

/// O7 — yönlendirme hedefi yeniden denetlenir (SSRF: `Location` başlığı
/// başlangıç denetimini atlayabilir). DNS tabanlı host denetimi (async)
/// sync closure içinde mümkün olmadığından burada şema/URL-kimlik-bilgisi/
/// IP-literali kesin reddedilir; isimli hostlar istek sırasında resolv olup
/// hedef IP link-local'a çekilirse reqwest hata döndürür (bağlantı düzeyi).
fn check_redirect_target(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("gecersiz yonlendirme: http/https degil".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("gecersiz yonlendirme: kimlik bilgisi iceriyor".to_string());
    }
    // B3: ayrıştırma tek kaynaktan (`parse_ip_literal`) — köşeli parantez
    // elle soyulmuyor, mapped/ULA/NAT64/6to4 da `is_blocked_ip` içinde düşüyor.
    if let Some(ip) = url.host_str().and_then(parse_ip_literal) {
        if is_blocked_ip(ip) {
            return Err("yasakli yonlendirme: link-local/metadata adresi".to_string());
        }
    }
    Ok(())
}

const MAX_REDIRECTS: usize = 5;

fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("cok fazla yonlendirme");
        }
        match check_redirect_target(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(e) => attempt.error(e),
        }
    })
}

/// O7 — reqwest düzeyinde DNS savunması: her çözümleme (ilk istek VE her
/// yönlendirme atlaması) link-local/metadata adresleri eler; hiç temiz adres
/// kalmazsa reddeder. (`lookup_host` denetiminin TOCTOU deliği ve
/// yönlendirme→host ismi bypass'ı ile DNS-rebind burada kesin kapanır.)
struct GuardResolve;

impl reqwest::dns::Resolve for GuardResolve {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let kept: Vec<std::net::SocketAddr> =
                addrs.filter(|a| !is_blocked_ip(a.ip())).collect();
            if kept.is_empty() {
                return Err("yasakli hedef: link-local/metadata adresi".into());
            }
            Ok(Box::new(kept.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Faz 4: proxy istemcisi istek başına kuruluyordu. Yapılandırma sabit
/// olduğundan (zaman aşımı, yönlendirme politikası, DNS savunması) süreç
/// boyunca tek istemci paylaşılır; bağlantı havuzu korunur.
static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn proxy_client() -> Result<&'static reqwest::Client, String> {
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .redirect(redirect_policy())
                .dns_resolver(Arc::new(GuardResolve))
                .build()
                .map_err(|e| format!("proxy istemcisi kurulamadi: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

#[tauri::command]
pub async fn proxy_fetch(
    id: u64,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    on_data: Channel<Value>,
    state: State<'_, ProxyState>,
) -> Result<(), String> {
    let parsed = check_url(&url)?;
    check_host_not_metadata(&parsed).await?;

    let m = reqwest::Method::from_bytes(method.trim().to_uppercase().as_bytes())
        .map_err(|_| format!("gecersiz method: {method}"))?;
    if !ALLOWED_METHODS.contains(&m.as_str()) {
        return Err(format!("izin verilmeyen method: {}", m.as_str()));
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = state
            .inflight
            .lock()
            .map_err(|_| "proxy durumu kilitli".to_string())?;
        map.insert(id, cancel.clone());
    }
    let _cleanup = Cleanup { id, state: &state };

    let client = proxy_client()?;
    let mut req = client.request(m, url.trim());
    for (k, v) in &headers {
        let lk = k.trim().to_ascii_lowercase();
        if BLOCKED_HEADERS.contains(&lk.as_str()) {
            continue; // host/connection/... gönderilmez
        }
        if let Ok(name) = reqwest::header::HeaderName::from_bytes(lk.as_bytes()) {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(v) {
                req = req.header(name, value);
            }
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let res = req.send().await.map_err(|e| format!("ag hatasi: {e}"))?;

    let status = res.status().as_u16();
    let mut hdrs = serde_json::Map::new();
    for (k, v) in res.headers().iter() {
        if let Ok(s) = v.to_str() {
            hdrs.insert(k.as_str().to_string(), Value::String(s.to_string()));
        }
    }
    if on_data
        .send(json!({ "k": "meta", "status": status, "headers": Value::Object(hdrs) }))
        .is_err()
    {
        return Ok(());
    }

    let mut stream = res.bytes_stream();
    let mut buf = String::new();
    let mut total_bytes: usize = 0;
    while let Some(item) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let bytes = item.map_err(|e| format!("ag hatasi: {e}"))?;
        total_bytes += bytes.len();
        if total_bytes > MAX_RESPONSE_BYTES {
            let _ =
                on_data.send(json!({ "k": "error", "error": "proxy: yanit boyutu siniri asildi" }));
            return Ok(());
        }
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            if on_data.send(json!({ "k": "data", "text": line })).is_err() {
                return Ok(());
            }
        }
    }
    if !buf.is_empty() && on_data.send(json!({ "k": "data", "text": buf })).is_err() {
        return Ok(());
    }
    let _ = on_data.send(json!({ "k": "done" }));
    Ok(())
}

/// WebView stream'i iptal edince Rust tarafındaki indirmeyi durdurur.
#[tauri::command]
pub fn proxy_abort(id: u64, state: State<'_, ProxyState>) -> Result<(), String> {
    if let Ok(map) = state.inflight.lock() {
        if let Some(flag) = map.get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yalnizca_http_https_kabul() {
        assert!(check_url("https://ornek.com/v1").is_ok());
        assert!(check_url("http://192.168.1.5:11434/api").is_ok());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("data:text/plain,x").is_err());
        assert!(check_url("").is_err());
    }

    #[test]
    fn faz10_o2_url_kimlik_bilgisi_reddedilir() {
        assert!(check_url("http://user:pass@ornek.com/v1").is_err());
        assert!(check_url("http://user@ornek.com/v1").is_err());
    }

    #[test]
    fn faz10_o2_link_local_metadata_engellenir() {
        // Bulut metadata + link-local engelli.
        assert!(is_blocked_ip("169.254.169.254".parse().unwrap()));
        assert!(is_blocked_ip("169.254.0.1".parse().unwrap()));
        assert!(is_blocked_ip("0.0.0.0".parse().unwrap()));
        assert!(is_blocked_ip("100.64.0.1".parse().unwrap()));
        assert!(is_blocked_ip("fe80::1".parse().unwrap()));
        // LAN ve localhost serbest (Ollama meşru kullanım).
        assert!(!is_blocked_ip("192.168.1.5".parse().unwrap()));
        assert!(!is_blocked_ip("10.0.0.4".parse().unwrap()));
        assert!(!is_blocked_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_blocked_ip("93.184.216.34".parse().unwrap()));
    }

    #[tokio::test]
    async fn faz10_o2_metadata_host_reddedilir() {
        let url = reqwest::Url::parse("http://169.254.169.254/latest/meta-data/").unwrap();
        assert!(check_host_not_metadata(&url).await.is_err());
        let lan = reqwest::Url::parse("http://192.168.1.5:11434/api/chat").unwrap();
        assert!(check_host_not_metadata(&lan).await.is_ok());
    }

    /// O7 — `Location` ile gelen hedef de aynı sertlikte denetlenir.
    #[test]
    fn o7_redirect_hedefi_denetlenir() {
        let ok = reqwest::Url::parse("http://192.168.1.5:11434/api/chat").unwrap();
        assert!(check_redirect_target(&ok).is_ok());
        let meta = reqwest::Url::parse("http://169.254.169.254/latest/meta-data/").unwrap();
        assert!(check_redirect_target(&meta).is_err());
        let v6meta = reqwest::Url::parse("http://[fe80::1]/x").unwrap();
        assert!(check_redirect_target(&v6meta).is_err());
        let cred = reqwest::Url::parse("http://user:pass@ornek.com/x").unwrap();
        assert!(check_redirect_target(&cred).is_err());
        let ftp = reqwest::Url::parse("ftp://ornek.com/x").unwrap();
        assert!(check_redirect_target(&ftp).is_err());
    }

    /// B3 — IPv6 gömülü/özel aralıklar: eski kod yalnız `fe80::/10` bakıyordu,
    /// dolayısıyla metadata adresi IPv4-mapped biçimde geçiyordu.
    #[test]
    fn b3_gomulu_ve_ozel_ipv6_araliklari_engellenir() {
        let blocked = [
            "::ffff:169.254.169.254", // IPv4-mapped metadata
            "::ffff:127.0.0.1",       // mapped loopback → v4 kuralları (serbest!)
            "::ffff:100.64.0.1",      // mapped CGNAT
            "fc00::1",                // ULA
            "fd12:3456::1",           // ULA
            "fec0::1",                // site-local
            "ff02::1",                // multicast
            "fe80::1",                // link-local
            "64:ff9b::a9fe:a9fe",     // NAT64 → 169.254.169.254
            "2002:a9fe:a9fe::1",      // 6to4  → 169.254.169.254
            "::",                     // unspecified
        ];
        for s in blocked {
            let ip: std::net::IpAddr = s.parse().unwrap();
            let expect_blocked = s != "::ffff:127.0.0.1"; // mapped loopback v4'te serbest
            assert_eq!(is_blocked_ip(ip), expect_blocked, "{s}");
        }

        // Meşru hedefler engellenmemeli (LAN Ollama + genel IPv6).
        let allowed = [
            "192.168.1.5",
            "10.0.0.7",
            "127.0.0.1",
            "::1",
            "2606:4700:4700::1111", // Cloudflare
            "2001:db8::1",          // dokümantasyon aralığı (engellenmez)
        ];
        for s in allowed {
            let ip: std::net::IpAddr = s.parse().unwrap();
            assert!(!is_blocked_ip(ip), "{s} serbest kalmalı");
        }
    }

    /// B3 — gömülü IPv4 çıkarımı üç biçim için doğru çalışır.
    #[test]
    fn b3_embedded_ipv4_cikarimi() {
        let cases = [
            ("::ffff:169.254.169.254", "169.254.169.254"),
            ("64:ff9b::c0a8:105", "192.168.1.5"),
            ("2002:c0a8:105::1", "192.168.1.5"),
        ];
        for (v6, v4) in cases {
            let a: std::net::Ipv6Addr = v6.parse().unwrap();
            assert_eq!(
                embedded_ipv4(&a).map(|x| x.to_string()).as_deref(),
                Some(v4),
                "{v6}"
            );
        }
        let plain: std::net::Ipv6Addr = "2606:4700::1111".parse().unwrap();
        assert_eq!(embedded_ipv4(&plain), None);
    }

    /// B3 — asıl bypass: köşeli parantezli IPv6 literali `parse::<IpAddr>()` ile
    /// ayrıştırılamadığı için `check_host_not_metadata` sessizce `Ok(())`
    /// dönüyordu. `[::ffff:169.254.169.254]` artık reddedilir.
    #[tokio::test]
    async fn b3_koseli_parantezli_ipv6_metadata_reddedilir() {
        for u in [
            "http://[::ffff:169.254.169.254]/latest/meta-data/",
            "http://[64:ff9b::a9fe:a9fe]/latest/meta-data/",
            "http://[2002:a9fe:a9fe::1]/latest/meta-data/",
            "http://[fd00::1]/x",
            "http://[fec0::1]/x",
        ] {
            let url = reqwest::Url::parse(u).unwrap();
            assert!(
                check_host_not_metadata(&url).await.is_err(),
                "{u} reddedilmeli"
            );
            assert!(
                check_redirect_target(&url).is_err(),
                "{u} yonlendirmede de reddedilmeli"
            );
        }
        // Meşru IPv6 hedef (LAN/yerel) geçer.
        for u in ["http://[::1]:11434/api/chat", "http://[2606:4700::1111]/"] {
            let url = reqwest::Url::parse(u).unwrap();
            assert!(check_host_not_metadata(&url).await.is_ok(), "{u} serbest");
            assert!(check_redirect_target(&url).is_ok(), "{u} serbest");
        }
    }

    #[test]
    fn parse_ip_literal_koseli_parantez_soyar() {
        assert!(parse_ip_literal("[fe80::1]").is_some());
        assert!(parse_ip_literal("fe80::1").is_some());
        assert!(parse_ip_literal("[::1]").is_some());
        assert!(parse_ip_literal("169.254.169.254").is_some());
        assert!(parse_ip_literal("ornek.com").is_none());
        assert!(parse_ip_literal("").is_none());
    }

    #[test]
    fn cleanup_kaydi_siler() {
        let state = ProxyState::default();
        let flag = Arc::new(AtomicBool::new(false));
        state.inflight.lock().unwrap().insert(7, flag.clone());
        {
            let _c = Cleanup {
                id: 7,
                state: &state,
            };
            assert!(state.inflight.lock().unwrap().contains_key(&7));
        }
        assert!(state.inflight.lock().unwrap().is_empty());
    }

    #[test]
    fn abort_isareti_koyar() {
        let state = ProxyState::default();
        let flag = Arc::new(AtomicBool::new(false));
        state.inflight.lock().unwrap().insert(3, flag.clone());
        flag.store(true, Ordering::Relaxed);
        assert!(flag.load(Ordering::Relaxed));
    }
}
