# AI Providers Setup

AI providers используются в Content Studio, Targeting Agent, Ads Automation и Reports.

## Required env

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `HEYGEN_API_KEY`
- `TAPNOW_API_KEY`

Ключи добавляются только в Vercel Environment Variables. UI показывает только configured/not configured status.

## Modules

- Content text generation: OpenAI, Anthropic, Gemini.
- Image prompt generation: OpenAI, Gemini, demo fallback.
- Voice generation: ElevenLabs или manual fallback.
- Avatar/video: HeyGen, TapNow или manual fallback.
- Targeting Agent: Anthropic или demo analysis.
- Reports: OpenAI/demo fallback.

## Fallback

Если env отсутствует, MVP не падает:

- Content Studio использует demo/manual fallback.
- Targeting Agent возвращает demo analysis через Railway service.
- Reports показывают demo report.

## Verification

1. Откройте `/admin`.
2. Перейдите в `Интеграции`.
3. Нажмите `Проверить всё`.
4. Перейдите в `Нейросети`.
5. Убедитесь, что нужные providers enabled и modelName заполнен.
