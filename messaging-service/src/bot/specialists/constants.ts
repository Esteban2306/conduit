export const IMAGE_ANALYSIS_CAPABILITY = 'image-analysis';

export const SPECIALIST_BLOCK_TEXT =
  'No pude verificar tu comprobante en este momento. Una persona del equipo lo revisará y te escribirá pronto. 🙏';

export const SUPPORTED_VERIFICATION_CAPABILITIES: readonly string[] = [
  IMAGE_ANALYSIS_CAPABILITY,
];

export const ACCEPTABLE_TOOL_VERDICTS = ['VALID', 'NEEDS_REVIEW'] as const;
