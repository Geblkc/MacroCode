import { createOpenAICompatibleProvider } from './openaiCompatible';

/**
 * NVIDIA NIM / build.nvidia.com — OpenAI uyumlu barındırılan API.
 *
 * Modeller çekirdeğe eklenmez: API anahtarı girildiğinde `/v1/models` uçundan
 * canlı keşif yapılır (model listesi sık değiştiği için tek kaynak API'dir).
 */
export const nvidiaProvider = createOpenAICompatibleProvider({
  name: 'nvidia',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  models: [],
});
