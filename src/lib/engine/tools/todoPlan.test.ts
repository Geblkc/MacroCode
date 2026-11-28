import { describe, expect, it } from 'vitest';
import { countPlanSteps, deriveTodoState, planStepIds } from './todo';

describe('Faz 8 L2 — plan adımları görev takibine bağlanır', () => {
  it('plan çağrısı adımları görev olarak üretir', () => {
    const state = deriveTodoState([
      {
        toolCalls: [{ name: 'plan', args: { steps: ['dosyayı oku', 'testleri çalıştır'] } }],
      },
    ]);
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({ id: 'plan-1', text: 'dosyayı oku', done: false });
    expect(state.items[1]).toMatchObject({ id: 'plan-2', text: 'testleri çalıştır' });
  });

  it('plan + todo karışımı: todo çağrıları da işlenir', () => {
    const state = deriveTodoState([
      { toolCalls: [{ name: 'plan', args: { steps: ['a', 'b'] } }] },
      { toolCalls: [{ name: 'todo', args: { action: 'complete', id: 'plan-1' } }] },
    ]);
    expect(state.items.find((t) => t.id === 'plan-1')?.done).toBe(true);
    expect(state.items.find((t) => t.id === 'plan-2')?.done).toBe(false);
  });

  it("birden fazla plan çağrısında id'ler çakışmaz", () => {
    const state = deriveTodoState([
      { toolCalls: [{ name: 'plan', args: { steps: ['a', 'b'] } }] },
      { toolCalls: [{ name: 'plan', args: { steps: ['c'] } }] },
    ]);
    expect(state.items.map((t) => t.id)).toEqual(['plan-1', 'plan-2', 'plan-3']);
  });

  it('boş adımlar atlanır', () => {
    const state = deriveTodoState([
      { toolCalls: [{ name: 'plan', args: { steps: ['  ', 'geçerli'] } }] },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].text).toBe('geçerli');
  });

  it('planStepIds verilen başlangıçtan sayar', () => {
    const call = { args: { steps: ['x', 'y'] } };
    expect(planStepIds(call, 0)).toEqual(['plan-1', 'plan-2']);
    expect(planStepIds(call, 5)).toEqual(['plan-6', 'plan-7']);
  });
});

describe('Bölüm 2 — plan ID üretimi çakışmaz (call.id tabanlı)', () => {
  it('call.id varsa ID çağrıya bağlıdır, sayaçtan bağımsızdır', () => {
    const first = { id: 'call-a', args: { steps: ['x', 'y'] } };
    const second = { id: 'call-b', args: { steps: ['z'] } };
    expect(planStepIds(first, 0)).toEqual(['plan-call-a-1', 'plan-call-a-2']);
    // İkinci çağrı ilk çağrının ID'lerini tekrar üretmez.
    expect(planStepIds(second, 0)).toEqual(['plan-call-b-1']);
  });

  it('call.id yoksa geçmişteki adımlar sayılıp sayaç kaydırılır', () => {
    expect(countPlanSteps([])).toBe(0);
    const history = [
      { toolCalls: [{ name: 'plan', args: { steps: ['a', 'b'] } }] },
      { toolCalls: [{ name: 'read_file', args: {} }] },
    ];
    expect(countPlanSteps(history)).toBe(2);
    expect(planStepIds({ args: { steps: ['c'] } }, countPlanSteps(history))).toEqual(['plan-3']);
  });

  it('araç çıktısındaki ID ile todo durumundaki ID birebir aynı', () => {
    const first = { id: 'call-a', name: 'plan', args: { steps: ['a', 'b'] } };
    const second = { id: 'call-b', name: 'plan', args: { steps: ['c'] } };
    // agent.ts'in ürettiği çıktı ID'leri:
    const emitted = [
      ...planStepIds(first, countPlanSteps([])),
      ...planStepIds(second, countPlanSteps([{ toolCalls: [first] }])),
    ];
    const state = deriveTodoState([{ toolCalls: [first] }, { toolCalls: [second] }]);
    expect(state.items.map((t) => t.id)).toEqual(emitted);
    expect(emitted).toEqual(['plan-call-a-1', 'plan-call-a-2', 'plan-call-b-1']);
  });

  it('todo complete, ikinci plan çağrısının adımını doğru işaretler', () => {
    const first = { id: 'call-a', name: 'plan', args: { steps: ['a', 'b'] } };
    const second = { id: 'call-b', name: 'plan', args: { steps: ['c'] } };
    const state = deriveTodoState([
      { toolCalls: [first] },
      { toolCalls: [second] },
      // Model ikinci planın adımını tamamlar (çıktıda gördüğü ID).
      { toolCalls: [{ name: 'todo', args: { action: 'complete', id: 'plan-call-b-1' } }] },
    ]);
    expect(state.items.find((t) => t.id === 'plan-call-a-1')?.done).toBe(false);
    expect(state.items.find((t) => t.id === 'plan-call-a-2')?.done).toBe(false);
    expect(state.items.find((t) => t.id === 'plan-call-b-1')?.done).toBe(true);
  });

  it('50 mesajlık pencere kaydığında sayaç ID kayması olmaz', () => {
    // 10 eski plan çağrısı (10 adım) + 50 dolgu → pencere yalnız son 50
    // mesajı görür, 10 eski plan çağrısının tamamı pencerenin dışında kalır.
    const old = Array.from({ length: 10 }, (_, i) => ({
      toolCalls: [{ name: 'plan', args: { steps: [`eski-${i}`] } }],
    }));
    const filler = Array.from({ length: 50 }, () => ({ toolCalls: [] }));
    const state = deriveTodoState([
      ...old,
      ...filler,
      { toolCalls: [{ name: 'plan', args: { steps: ['yeni'] } }] },
    ]);
    // Pencere içindeki tek plan çağrısı, dışarıdaki 10 adımı sayarak 11'den başlar.
    expect(state.items.map((t) => t.id)).toEqual(['plan-11']);
  });
});
