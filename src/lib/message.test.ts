import { describe, expect, it } from 'vitest';
import { isBlankAssistantMessage } from './message';
import type { Message } from '../types';

const assistant = (patch: Partial<Message> = {}): Message => ({
  id: 'a0',
  role: 'assistant',
  content: '',
  timestamp: 1,
  ...patch,
});

describe('isBlankAssistantMessage — sessiz veri kaybı koruması', () => {
  it('gerçekten boş asistan mesajı boş sayılır', () => {
    expect(isBlankAssistantMessage(assistant())).toBe(true);
  });

  it('reasoning içeren mesaj boş sayılmaz', () => {
    expect(isBlankAssistantMessage(assistant({ reasoning: 'düşünüyorum' }))).toBe(false);
  });

  it('imzalı thinking bloğu içeren mesaj boş sayılmaz', () => {
    expect(
      isBlankAssistantMessage(assistant({ thinking: [{ thinking: 'adım', signature: 'sig' }] })),
    ).toBe(false);
  });

  it('görsel içeren mesaj boş sayılmaz', () => {
    expect(isBlankAssistantMessage(assistant({ images: ['data:image/jpeg;base64,x'] }))).toBe(
      false,
    );
  });

  it('tool çağrısı içeren mesaj boş sayılmaz', () => {
    expect(
      isBlankAssistantMessage(
        assistant({ toolCalls: [{ id: 'c1', name: 'read_file', args: {} }] }),
      ),
    ).toBe(false);
  });

  it('metin varsa boş sayılmaz', () => {
    expect(isBlankAssistantMessage(assistant({ content: 'cevap' }))).toBe(false);
  });

  it('user mesajı asistan mesajı değildir', () => {
    expect(isBlankAssistantMessage(assistant({ role: 'user' }))).toBe(false);
  });
});
