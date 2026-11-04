import { DEFAULT_MODELS } from '../constants/default-models';
import { AiProviderType } from '../ai/interface/AiProviderType';

export function resolveModel(
  provider: AiProviderType,
  model?: string | null,
): string {
  if (!model || model.trim().length === 0) {
    return DEFAULT_MODELS[provider];
  }

  return model;
}
