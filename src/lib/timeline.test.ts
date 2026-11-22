import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';
import type { ExtraLine, Message } from '../types';

function msg(
  p: Partial<Message> & Pick<Message, 'id' | 'role' | 'content' | 'timestamp'>,
): Message {
  return { ...p } as Message;
}

function extra(
  p: Partial<ExtraLine> & Pick<ExtraLine, 'id' | 'type' | 'content' | 'ts'>,
): ExtraLine {
  return { ...p } as ExtraLine;
}

describe('buildTimeline — kronolojik akış', () => {
  it('araç kartını çağrı anına koyar, son cevabın üstünde bırakmaz', () => {
    const messages: Message[] = [
      msg({ id: 'u1', role: 'user', content: 'oku', timestamp: 1000 }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: 'dosyayı okuyorum',
        timestamp: 2000,
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/a.ts' } }],
      }),
      msg({
        id: 'r1',
        role: 'system',
        content: 'içerik',
        timestamp: 2500,
        toolCallId: 'c1',
        toolName: 'read_file',
      }),
      msg({ id: 'a2', role: 'assistant', content: 'bitti', timestamp: 3000 }),
    ];

    const items = buildTimeline({ messages, extras: [] });
    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'tool', 'message']);
    expect(items.map((i) => i.key)).toEqual(['u1', 'a1', 'tool-c1', 'a2']);
    const tool = items[2];
    expect(tool.kind === 'tool' && tool.tool.status).toBe('ok');
    expect(tool.kind === 'tool' && tool.tool.target).toBe('src/a.ts');
  });

  it('ham araç sonucu system satırını gizler', () => {
    const messages: Message[] = [
      msg({ id: 'u1', role: 'user', content: 'x', timestamp: 1 }),
      msg({ id: 'r1', role: 'system', content: 'gizli', timestamp: 2, toolCallId: 'c9' }),
    ];
    const items = buildTimeline({ messages, extras: [] });
    expect(items.map((i) => i.key)).toEqual(['u1', 'tool-c9']);
  });

  it('yeniden başlatmada (extras yok) kartları mesajlardan kurar', () => {
    const messages: Message[] = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: 'bakıyorum',
        timestamp: 10,
        toolCalls: [{ id: 'c1', name: 'grep', args: { pattern: 'foo' } }],
      }),
      msg({
        id: 'r1',
        role: 'system',
        content: '2 eşleşme',
        timestamp: 11,
        toolCallId: 'c1',
        toolName: 'grep',
      }),
    ];
    const items = buildTimeline({ messages, extras: [] });
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.tool.output).toBe('2 eşleşme');
    expect(tool?.kind === 'tool' && tool.tool.target).toBe('foo');
  });

  it('canlı çıktı aynı kartı günceller, ikinci kart açmaz', () => {
    const extras: ExtraLine[] = [
      extra({
        id: 'e1',
        type: 'sys',
        content: 'run',
        ts: 20,
        tool: { id: 'c1', name: 'exec', args: 'cmd=npm', status: 'run' },
      }),
      extra({
        id: 'e2',
        type: 'sys',
        content: 'out',
        ts: 21,
        tool: { id: 'c1', name: 'exec', args: '', status: 'run', output: 'a\nb' },
      }),
      extra({
        id: 'e3',
        type: 'sys',
        content: 'done',
        ts: 22,
        tool: { id: 'c1', name: 'exec', args: '', status: 'ok', output: 'a\nb\nc' },
      }),
    ];
    const items = buildTimeline({ messages: [], extras });
    const toolItems = items.filter((i) => i.kind === 'tool');
    expect(toolItems).toHaveLength(1);
    const tool = toolItems[0];
    expect(tool.kind === 'tool' && tool.tool.status).toBe('ok');
    expect(tool.kind === 'tool' && tool.tool.output).toBe('a\nb\nc');
    expect(tool.kind === 'tool' && tool.tool.args).toBe('cmd=npm');
    expect(tool.ts).toBe(20);
  });

  it('çağrı zaman damgası kartı doğru yere koyar ve süreyi ölçer', () => {
    const messages: Message[] = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: 'çalışıyorum',
        timestamp: 1000,
        toolCalls: [{ id: 'c1', name: 'exec', args: { cmd: 'npm' }, ts: 1500 }],
      }),
      msg({
        id: 'r1',
        role: 'system',
        content: 'ok',
        timestamp: 2000,
        toolCallId: 'c1',
        toolName: 'exec',
      }),
      msg({ id: 'a2', role: 'assistant', content: 'bitti', timestamp: 2100 }),
    ];
    const items = buildTimeline({ messages, extras: [] });
    expect(items.map((i) => i.key)).toEqual(['a1', 'tool-c1', 'a2']);
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.tool.ms).toBe(500);
  });

  it('extras attığında kart "çalışıyor"da takılmaz', () => {
    // Extras cap'i eski çağrı satırını attı; mesajdaki sonuç elde kaldı.
    const messages: Message[] = [
      msg({
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 10,
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
      }),
      msg({
        id: 'r1',
        role: 'system',
        content: 'tamam',
        timestamp: 11,
        toolCallId: 'c1',
        toolName: 'read_file',
      }),
    ];
    const extras: ExtraLine[] = [
      extra({
        id: 'e1',
        type: 'sys',
        content: 'call',
        ts: 10,
        tool: { id: 'c1', name: 'read_file', args: 'path=a.ts', status: 'run' },
      }),
    ];
    const items = buildTimeline({ messages, extras });
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.tool.status).toBe('ok');
    expect(tool?.kind === 'tool' && tool.tool.output).toBe('tamam');
  });

  it('hata satırını oluştuğu yerde bırakır', () => {
    const extras: ExtraLine[] = [
      extra({ id: 'err1', type: 'err', content: '✗ patladı', ts: 15 }),
      extra({ id: 'info1', type: 'sys', content: 'sonra', ts: 30 }),
    ];
    const messages: Message[] = [
      msg({ id: 'a1', role: 'assistant', content: 'cevap', timestamp: 20 }),
    ];
    const items = buildTimeline({ messages, extras });
    expect(items.map((i) => i.key)).toEqual(['err1', 'a1', 'info1']);
  });

  it('clearedBefore öncesini gizler', () => {
    const messages: Message[] = [
      msg({ id: 'u1', role: 'user', content: 'eski', timestamp: 1 }),
      msg({ id: 'u2', role: 'user', content: 'yeni', timestamp: 5 }),
    ];
    const extras: ExtraLine[] = [extra({ id: 'e1', type: 'sys', content: 'eski', ts: 2 })];
    const items = buildTimeline({ messages, extras, clearedBefore: 4 });
    expect(items.map((i) => i.key)).toEqual(['u2']);
  });
});
