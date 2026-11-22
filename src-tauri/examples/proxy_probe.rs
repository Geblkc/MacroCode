use reqwest::dns::{Addrs, Name, Resolve, Resolving};

struct GuardResolve;

impl Resolve for GuardResolve {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let kept: Vec<std::net::SocketAddr> = addrs.collect();
            println!("DNS {host} -> {kept:?}");
            Ok(Box::new(kept.into_iter()) as Addrs)
        })
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .dns_resolver(std::sync::Arc::new(GuardResolve))
        .build()
        .unwrap();
    for url in [
        "https://evren-llmapi.ssyz.org.tr/v1/models",
        "https://integrate.api.nvidia.com/v1/models",
    ] {
        match client
            .get(url)
            .header("authorization", "Bearer test")
            .send()
            .await
        {
            Ok(r) => println!("{url} -> {}", r.status()),
            Err(e) => println!("{url} -> ERROR: {e:?}"),
        }
    }
}
