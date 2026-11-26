import { describe, expect, it } from 'vitest';
import { createTimelineModel } from './timelineModel';
import type { ExtraLine, Message } from '../types';
import type { TimelineItem } from './timeline';

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

function messageItems(items: TimelineItem[]) {
  return items.filter((i): i is Extract<TimelineItem, { kind: 'message' }> => i.kind === 'message');
}

describe('Faz 3 — TimelineModel', () => {
  it('son mesaj içeriği değişince yalnız o satırı kopyalar', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'soru', timestamp: 1000 });
    const a = msg({ id: 'a1', role: 'assistant', content: 'cevap', timestamp: 2000 });
    const model = createTimelineModel();

    const first = model.build({ messages: [u, a], extras: [] });
    const firstMsgs = messageItems(first);

    // Store `updateLastMessage` davranışı: yalnız son mesaj yeni nesne.
    const a2 = { ...a, content: 'cevap devam' };
    const second = model.build({ messages: [u, a2], extras: [] });
    const secondMsgs = messageItems(second);

    expect(secondMsgs[0]).toBe(firstMsgs[0]); // önceki satır referansı korunur
    expect(secondMsgs[1]).not.toBe(firstMsgs[1]);
    expect(secondMsgs[1].message.content).toBe('cevap devam');
    // İskelet satırı kopyalanır, özgün önbellek bozulmaz.
    expect(firstMsgs[1].message.content).toBe('cevap');
    expect(secondMsgs[1].seq).toBe(firstMsgs[1].seq);
  });

  it('yeni mesaj eklenince sıfırdan kurar ve sıralama doğrudur', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'a', timestamp: 1000 });
    const a = msg({ id: 'a1', role: 'assistant', content: 'b', timestamp: 2000 });
    const model = createTimelineModel();
    model.build({ messages: [u], extras: [] });

    const items = model.build({ messages: [u, a], extras: [] });
    expect(items.map((i) => i.key)).toEqual(['u1', 'a1']);
  });

  it('araç çağrısı eklenince kart oluşur ve sonuç birleşir', () => {
    const u = msg({ id: 'u1', role: 'user', content: 'oku', timestamp: 1000 });
    const a = msg({
      id: 'a1',
      role: 'assistant',
      content: 'okuyorum',
      timestamp: 2000,
      toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/a.ts' } }],
    });
    const model = createTimelineModel();
    model.build({ messages: [u, a], extras: [] });

    const result = msg({
      id: 'r1',
      role: 'system',
      content: 'içerik',
      timestamp: 2500,
      toolCallId: 'c1',
      toolName: 'read_file',
    });
    const items = model.build({ messages: [u, a, result], extras: [] });
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.tool.status).toBe('ok');
    expect(tool?.kind === 'tool' && tool.tool.output).toBe('içerik');
  });

  it('extras güncellemesi iskeleti değiştirmez (kart kopyası üretir)', () => {
    const a = msg({
      id: 'a1',
      role: 'assistant',
      content: 'çalıştırıyorum',
      timestamp: 1000,
      toolCalls: [{ id: 'c1', name: 'exec', args: { cmd: 'ls' } }],
    });
    const model = createTimelineModel();
    const base = model.build({ messages: [a], extras: [] });
    const baseTool = base.find((i) => i.kind === 'tool');

    const live = extra({
      id: 'e1',
      type: 'sys',
      content: '/// tool ▸ exec',
      ts: 1200,
      tool: {
        id: 'c1',
        name: 'exec',
        args: '',
        status: 'run',
        output: 'a\nb\n',
      },
    });
    const merged = model.build({ messages: [a], extras: [live] });
    const mergedTool = merged.find((i) => i.kind === 'tool');
    expect(mergedTool).not.toBe(baseTool);
    expect(mergedTool?.kind === 'tool' && mergedTool.tool.output).toBe('a\nb\n');
    // Önbellekteki iskelet kartı canlı çıktıyla kirlenmemeli.
    expect(baseTool?.kind === 'tool' && baseTool.tool.output).toBeUndefined();
  });

  it('clearedBefore öncesini gizler, sonrasında hızlı yol bozulmaz', () => {
    const old = msg({ id: 'u0', role: 'user', content: 'eski', timestamp: 500 });
    const u = msg({ id: 'u1', role: 'user', content: 'yeni', timestamp: 1500 });
    const a = msg({ id: 'a1', role: 'assistant', content: 'cevap', timestamp: 2000 });
    const model = createTimelineModel();

    const items = model.build({ messages: [old, u, a], extras: [], clearedBefore: 1000 });
    expect(items.map((i) => i.key)).toEqual(['u1', 'a1']);

    const a2 = { ...a, content: 'cevap 2' };
    const next = model.build({ messages: [old, u, a2], extras: [], clearedBefore: 1000 });
    expect(next.map((i) => i.key)).toEqual(['u1', 'a1']);
    const last = next.find((i) => i.kind === 'message' && i.key === 'a1');
    expect(last?.kind === 'message' && last.message.content).toBe('cevap 2');
  });

  it('reset sonrası ilk kurulum sıfırdan yapılır', () => {
    const a = msg({ id: 'a1', role: 'assistant', content: 'x', timestamp: 1000 });
    const model = createTimelineModel();
    const first = model.build({ messages: [a], extras: [] });
    model.reset();
    const again = model.build({ messages: [a], extras: [] });
    expect(again[0]).not.toBe(first[0]);
    expect(again[0].kind === 'message' && again[0].message.content).toBe('x');
  });
});
