import { describe, expect, it } from 'vitest';
import {
  applyTodoAction,
  deriveTodoState,
  formatTodos,
  TODO_WINDOW_MESSAGES,
  todoWindow,
  type TodoState,
} from './todo';

const EMPTY: TodoState = { items: [] };

describe('Faz 3 — todo', () => {
  it('add/complete/list geçişleri', () => {
    const a = applyTodoAction(EMPTY, { action: 'add', text: 'testleri yaz' });
    expect(a.state.items).toHaveLength(1);
    expect(a.state.items[0]).toMatchObject({ text: 'testleri yaz', done: false });
    const id = a.state.items[0].id;
    expect(a.output).toContain(id);
    const c = applyTodoAction(a.state, { action: 'complete', id });
    expect(c.state.items[0].done).toBe(true);
    expect(c.output).toContain('[x]');
    const l = applyTodoAction(c.state, { action: 'list' });
    expect(l.state).toEqual(c.state);
    expect(l.output).toContain('[x]');
  });

  it('geçersiz girişler hata verir', () => {
    expect(() => applyTodoAction(EMPTY, { action: 'add', text: '' })).toThrow(/text gerekli/);
    expect(() => applyTodoAction(EMPTY, { action: 'complete', id: 'yok' })).toThrow(/bulunamadı/);
    expect(() => applyTodoAction(EMPTY, { action: 'sil' })).toThrow(/bilinmeyen todo action/);
    expect(formatTodos(EMPTY)).toBe('(todo yok)');
  });

  it('deriveTodoState history’den türetir', () => {
    const history = [
      { toolCalls: [{ name: 'read_file', args: {} }] },
      { toolCalls: [{ name: 'todo', args: { action: 'add', id: 't1', text: 'bir' } }] },
      { toolCalls: [{ name: 'todo', args: { action: 'add', id: 't2', text: 'iki' } }] },
      { toolCalls: [{ name: 'todo', args: { action: 'complete', id: 't1' } }] },
      // Bozuk çağrı türetmeyi kırmaz.
      { toolCalls: [{ name: 'todo', args: { action: 'complete', id: 'yok' } }] },
    ];
    const s = deriveTodoState(history);
    expect(s.items).toHaveLength(2);
    expect(s.items.find((t) => t.id === 't1')?.done).toBe(true);
    expect(s.items.find((t) => t.id === 't2')?.done).toBe(false);
  });

  it('ilgisiz sohbet mesajları görev listesini düşürmez', () => {
    // 200 normal mesaj araya girse de 5 todo çağrısı korunur (eski davranış
    // ham 50 mesajlık pencere yüzünden listeyi kaybediyordu).
    const starter = [
      { toolCalls: [{ name: 'todo', args: { action: 'add', id: 'a', text: 'bir' } }] },
      { toolCalls: [{ name: 'todo', args: { action: 'add', id: 'b', text: 'iki' } }] },
    ];
    const chatter = Array.from({ length: 200 }, () => ({ toolCalls: [] }));
    const tail = [{ toolCalls: [{ name: 'todo', args: { action: 'complete', id: 'a' } }] }];
    const s = deriveTodoState([...starter, ...chatter, ...tail]);
    expect(s.items.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.items.find((t) => t.id === 'a')?.done).toBe(true);
    expect(s.items.find((t) => t.id === 'b')?.done).toBe(false);
  });

  it('ilgili mesaj sayısı pencereyi aşarsa en yeniler taranır', () => {
    const history = Array.from({ length: 60 }, (_, i) => ({
      toolCalls: [{ name: 'todo', args: { action: 'add', id: `t-${i}`, text: 'x' } }],
    }));
    const s = deriveTodoState(history);
    expect(s.items).toHaveLength(TODO_WINDOW_MESSAGES);
    expect(s.items[0].id).toBe('t-10');
  });

  it('todoWindow ilgisiz mesajları pencere dışında bırakmaz', () => {
    const history = [
      { toolCalls: [{ name: 'read_file', args: {} }] },
      { toolCalls: [{ name: 'todo', args: { action: 'add', id: 'a', text: 'bir' } }] },
    ];
    const { window, prefix } = todoWindow(history);
    expect(window).toEqual(history);
    expect(prefix).toEqual([]);
  });

  it('seed: compaction ile düşen görevler korunur', () => {
    // Oturumun tamamından türetilmiş durum (tohum).
    const seed = { items: [{ id: 'plan-1', text: 'birinci', done: true }] };
    // Sıkıştırılmış geçmiş yalnız yeni çağrıyı taşır.
    const compacted = [
      { toolCalls: [{ name: 'todo', args: { action: 'add', id: 't2', text: 'ikinci' } }] },
    ];
    const s = deriveTodoState(compacted, seed);
    expect(s.items.map((t) => t.id)).toEqual(['plan-1', 't2']);
    expect(s.items[0].done).toBe(true);
    // Tohum mutasyona uğramaz.
    expect(seed.items).toHaveLength(1);
  });

  it('seed: sayaç tabanlı plan ID üretimi tohumdan devam eder', () => {
    const seed = {
      items: [
        { id: 'plan-1', text: 'a', done: false },
        { id: 'plan-2', text: 'b', done: false },
      ],
    };
    const s = deriveTodoState([{ toolCalls: [{ name: 'plan', args: { steps: ['c'] } }] }], seed);
    expect(s.items.map((t) => t.id)).toEqual(['plan-1', 'plan-2', 'plan-3']);
  });
});
