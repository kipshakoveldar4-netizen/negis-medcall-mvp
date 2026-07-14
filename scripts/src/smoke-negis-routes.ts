import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type ApiBody = {
  success?: boolean;
  mode?: string;
  error?: string;
  details?: string[];
  data?: unknown;
};

export {};

const baseUrl = (
  process.env.NEGIS_SMOKE_BASE_URL ||
  process.env.NEGIS_BASE_URL ||
  "http://localhost:5173"
).replace(/\/$/, "");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function assertSourceIncludes(source: string, expected: string, label: string) {
  if (!source.includes(expected)) {
    throw new Error(`AdsAutomation source is missing ${label}`);
  }
}

function assertSourceExcludes(source: string, forbidden: string, label: string) {
  if (source.includes(forbidden)) {
    throw new Error(`AdsAutomation source still contains ${label}`);
  }
}

async function checkAdsAutomationSource() {
  const source = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"), "utf8");

  assertSourceIncludes(source, "publicURL", "publicURL normalization");
  assertSourceIncludes(source, "buildFrontendStoragePublicUrl(storagePath, storageBucket)", "publicUrl derivation from storagePath");
  assertSourceIncludes(source, "Техническая информация", "collapsed technical info block");
  assertSourceIncludes(source, "Клиентский режим", "client/admin mode toggle");
  assertSourceIncludes(source, "clientWizardSteps", "four-step client wizard");
  assertSourceIncludes(source, "Сводка запуска", "clean medical launch summary");
  assertSourceIncludes(source, "Безопасный режим: реклама создаётся выключенной", "safe launch mode copy");
  assertSourceIncludes(source, "getCreativeReadiness", "central creative readiness helper");
  assertSourceIncludes(source, "getPreviewReadiness", "central preview readiness helper");
  assertSourceIncludes(source, "ready_for_meta", "ready_for_meta creative status");
  assertSourceIncludes(source, "needs_optimization", "large video optimization readiness status");
  assertSourceIncludes(source, "needs_thumbnail", "video thumbnail readiness status");
  assertSourceIncludes(source, "too_large", "large video readiness status");
  assertSourceIncludes(source, "Предпросмотр выбранного файла", "local preview must be labelled as selected-file preview");
  assertSourceIncludes(source, "Видео слишком большое для прямой загрузки", "friendly large video error");
  assertSourceIncludes(source, "Не удалось подготовить публичную ссылку для Meta", "friendly publicUrl error");
  assertSourceIncludes(source, "Не удалось создать обложку видео. Для запуска видео в Meta нужна обложка.", "friendly thumbnail error");
  assertSourceIncludes(source, "upload error raw", "admin-only raw upload error detail");
  assertSourceIncludes(source, "Так будет выглядеть реклама", "client-friendly ad preview title");
  assertSourceIncludes(source, "Сначала подготовьте креатив.", "preview blocked when creative is not ready");
  assertSourceIncludes(source, "Заполните параметры кампании.", "preview blocked when parameters are missing");
  assertSourceIncludes(source, "Кнопка ведёт в WhatsApp", "WhatsApp destination preview");
  assertSourceIncludes(source, "Площадка: Instagram", "Instagram placement preview");
  assertSourceIncludes(source, "Мы создадим кампанию в Meta выключенной", "safe preview launch copy");
  assertSourceIncludes(source, "Технические данные предпросмотра", "admin-only preview technical details");
  assertSourceIncludes(source, "launch status target:", "preview technical launch status");
  assertSourceIncludes(source, "Перейти к запуску", "preview launch button");
  assertSourceIncludes(source, "Назад к предпросмотру", "step 6 back to preview button");
  assertSourceIncludes(source, "Создать рекламу в Meta выключенной", "paused-only real launch button");
  assertSourceIncludes(source, "errors.length > 0", "real launch button is disabled until preview/prelaunch checks pass");
  assertSourceIncludes(source, 'imageUrl: creative?.fileType === "image" ? creativeUrl : ""', "imageUrl launch payload");
  assertSourceIncludes(source, 'videoUrl: creative?.fileType === "video" ? creativeUrl : ""', "videoUrl launch payload");
  assertSourceIncludes(source, "Не удалось загрузить файл.", "failed upload message");
  assertSourceIncludes(source, "getting_signed_url", "signed URL status");
  assertSourceIncludes(source, "uploading_to_storage", "Storage upload status");
  assertSourceIncludes(source, "saving_metadata", "metadata save status");
  assertSourceIncludes(source, "setUploadStatus(\"failed\")", "failed upload state");
  assertSourceIncludes(source, "const creativeCanContinue = readiness.isReadyForMeta", "next step requires ready_for_meta");
  assertSourceIncludes(source, "uploadToSignedUrl", "signed Supabase upload call");
  assertSourceIncludes(source, "/api/crm/ad-creatives/signed-upload", "signed upload endpoint");
  assertSourceIncludes(source, "/api/crm/ad-creatives", "metadata save endpoint");
  assertSourceIncludes(source, "signed_url", "signed upload metadata marker");
  assertSourceIncludes(source, "lastUploadError", "detailed upload error state");
  assertSourceIncludes(source, "VERCEL_FUNCTION_FILE_LIMIT_BYTES", "Vercel payload guard");
  assertSourceIncludes(source, "creative.imageUploadMode", "Meta image upload mode debug");
  assertSourceIncludes(source, "creative.pictureUrl", "Meta picture URL fallback debug");
  assertSourceIncludes(source, "creative.imageUploadCapabilityFallback", "Meta image upload fallback debug");
  assertSourceIncludes(source, "VIDEO_REAL_LAUNCH_DISABLED_MESSAGE", "video real launch disabled copy");
  assertSourceIncludes(source, "VIDEO_LAUNCH_SOON_MESSAGE", "video launch soon helper text");
  assertSourceIncludes(source, "MOV_VIDEO_WARNING", "MOV upload warning");
  assertSourceIncludes(source, "VIDEO_LAUNCH_ENABLED_MESSAGE", "video launch enabled helper text");
  assertSourceIncludes(source, "VIDEO_FORMAT_ERROR", "video format validation message");
  assertSourceIncludes(source, "creative.videoLaunchEnabled", "video launch flag debug");
  assertSourceIncludes(source, "creative.metaVideoLaunchStatus", "video launch status debug");
  assertSourceIncludes(source, "video.mimeType", "video MIME debug");
  assertSourceIncludes(source, "video.uploadMode", "video upload mode debug");
  assertSourceIncludes(source, "video.videoId", "video ID debug");
  assertSourceIncludes(source, "Meta Video ID", "video ID launch result");
  assertSourceIncludes(source, "KZ_META_CITY_OPTIONS", "controlled Kazakhstan city options");
  assertSourceIncludes(source, "selectedCityId", "selected city id launch payload");
  assertSourceIncludes(source, "selectedCityCanonicalName", "selected city canonical name launch payload");
  assertSourceIncludes(source, "<select", "controlled city select");
  assertSourceExcludes(source, 'Field label="Город" value={brief.city}', "free-text city Field");
  assertSourceIncludes(source, "cityRadiusKm", "city radius disabled debug");
  assertSourceIncludes(source, "usesRadius", "usesRadius debug");
  assertSourceExcludes(source, "targetingRadiusKm", "city radius report variable");
  assertSourceExcludes(source, "радиус ${targeting", "radius wording in final city report");
  assertSourceIncludes(source, "Meta не разрешила стандартную загрузку изображения", "Meta image upload fallback warning");
  assertSourceExcludes(source, "/api/crm/ad-creative-upload", "file upload endpoint in UI");
  assertSourceExcludes(source, "new FormData(", "multipart upload from UI");
  assertSourceExcludes(source, ".upload(storagePath, file", "anonymous Supabase upload call");
  assertSourceExcludes(source, "Файл загружается. Подождите несколько секунд.", "stale endless upload message");
  assertSourceIncludes(source, "resolveLaunchMode", "history launch mode normalization");
  assertSourceIncludes(source, "isDryRunMetaId", "dryrun_ Meta ID detection");
  assertSourceIncludes(source, "Параметры проверены. Реклама в Meta не создавалась.", "dry-run history status copy");
  assertSourceIncludes(source, "Создана выключенной", "real PAUSED history badge");
  assertSourceIncludes(source, "Видео обрабатывается", "video processing history badge");
  assertSourceIncludes(source, "Проверить готовность видео", "video processing recheck action");
  assertSourceIncludes(source, "Видео принято Meta и обрабатывается. Это не ошибка.", "video processing in-progress copy");
  assertSourceIncludes(source, "lastCheckedAt", "video processing lastCheckedAt display");
  assertSourceIncludes(source, "VideoProcessingPendingError", "controlled pending video state");
  assertSourceIncludes(source, 'metaVideoId: creative.metaVideoId || ""', "video_id reuse in meta upload request");
  assertSourceIncludes(source, "captureVideoThumbnail", "automatic video thumbnail capture");
  assertSourceIncludes(source, "uploadVideoThumbnail", "thumbnail upload through signed storage flow");
  assertSourceIncludes(source, "Обложка видео создана автоматически", "auto thumbnail ready message");
  assertSourceIncludes(source, "Не удалось автоматически создать обложку видео", "controlled thumbnail failure warning");
  assertSourceIncludes(source, "Создать обложку заново", "thumbnail regenerate action");
  assertSourceIncludes(source, 'thumbnailSource: "auto_frame"', "auto_frame thumbnail source metadata");
  assertSourceIncludes(source, "thumbnailGeneratedAt", "thumbnail generation timestamp metadata");
  assertSourceIncludes(source, "video.thumbnailUrl", "thumbnail debug in technical info");
  assertSourceIncludes(source, "creative.videoDataHasImageUrl", "video_data image_url debug in technical info");
  assertSourceIncludes(source, "Реклама создана в Meta выключенной", "paused launch success title");
  assertSourceIncludes(source, "Технические данные", "collapsed technical IDs on the success screen");
  assertSourceIncludes(source, "Создать новый запуск", "start new launch action on the success screen");
  assertSourceIncludes(source, "Бюджет в день", "human budget summary on the success screen");
  assertSourceIncludes(source, "Тип креатива", "creative type in the success summary");
  assertSourceIncludes(source, 'text-amber-800">{launchResult.warning}', "launch warnings rendered amber, not red");
  assertSourceIncludes(source, "launchResult && !launchResult.dryRun", "success screen only for real launches");
  assertSourceIncludes(source, "matchesHistoryFilter", "history filter logic");
  assertSourceIncludes(source, "matchesHistorySearch", "history search logic");
  assertSourceIncludes(source, "mergeHistoryCollections", "local and API history deduplication");
  assertSourceIncludes(source, "historyLoaded", "history loading and empty-state separation");
  // Negis OS history header (exact spec copy).
  assertSourceIncludes(source, "Все рекламные кампании, созданные через Negis OS.", "Negis OS history subtitle");
  // Summary metric cards.
  assertSourceIncludes(source, "Всего запусков", "total launches metric");
  assertSourceIncludes(source, "Создано выключенными", "paused-created count metric");
  assertSourceIncludes(source, "Видео оптимизировано", "optimized video count metric");
  assertSourceIncludes(source, "Тесты без создания рекламы", "dry-run count metric");
  // Client-friendly filters (exact spec set).
  assertSourceIncludes(source, "Создано выключенной", "created-paused history filter");
  assertSourceIncludes(source, "Ошибки", "failed launch history filter");
  assertSourceIncludes(source, "Оптимизированные видео", "optimized video history filter");
  assertSourceIncludes(source, "Кампания, услуга или город", "client-safe history search placeholder");
  assertSourceIncludes(source, "Кампания, услуга, город или Meta ID", "admin history search placeholder");
  assertSourceIncludes(source, "Сбросить фильтры", "history no-results recovery action");
  assertSourceIncludes(source, "Подробнее", "collapsed client and admin history details");
  assertSourceIncludes(source, "Запусков пока нет", "history empty-state title");
  assertSourceIncludes(source, "never the raw video URL", "history video preview uses thumbnail only");
  assertSourceIncludes(source, "Повторить запуск с этими параметрами", "repeat launch prefill action");
  assertSourceIncludes(source, "repeatLaunchFromHistory", "repeat launch prefill handler");
  assertSourceIncludes(source, "Параметры перенесены из истории", "prefill without auto-launch notice");
  assertSourceExcludes(source, "isRealLaunch || mode === \"failed\" ? (", "Meta IDs shown outside real launches");
  assertSourceIncludes(source, "uploadLargeVideo", "large video optimization branch");
  assertSourceIncludes(source, "file.size > optimizationThresholdBytes", "threshold comparison in bytes");
  assertSourceIncludes(source, "exceedsThreshold && optimization?.enabled === true", "large video branch gated by flag and threshold");
  assertSourceIncludes(source, "exceedsThreshold && !optimization", "large files blocked while optimization config is missing");
  assertSourceIncludes(source, "Настройки оптимизации видео ещё загружаются", "config loading block message");
  assertSourceIncludes(source, "largeVideoBranch", "large video branch debug flag");
  assertSourceIncludes(source, "fileSizeMb", "file size debug field");
  assertSourceIncludes(source, 'uploadTarget: "ad-creatives"', "direct upload target debug");
  assertSourceIncludes(source, "uploadTarget: storageBucket", "raw upload target debug from server response");
  assertSourceIncludes(source, "VIDEO_OPTIMIZING_MESSAGE", "public link state replaced while optimizing");
  assertSourceIncludes(source, "Идёт оптимизация для рекламы", "video optimization in-progress message");
  assertSourceIncludes(source, "Видео оптимизировано и готово для Meta", "video optimization ready message");
  assertSourceIncludes(source, "Видео ещё оптимизируется", "real launch blocked while optimizing message");
  assertSourceIncludes(source, "if (videoJobPending) errors.push(VIDEO_OPTIMIZING_LAUNCH_BLOCKED_MESSAGE)", "prelaunch gate while optimization job runs");
  assertSourceIncludes(source, "publicUrl: job.outputPublicUrl || current.publicUrl", "creative publicUrl comes only from the optimized output");
  assertSourceIncludes(source, "thumbnailUrl: job.thumbnailPublicUrl || current.thumbnailUrl", "thumbnailUrl comes from the optimization job");
  // Optimized-video → Meta wiring (worker output becomes the ready creative).
  assertSourceIncludes(source, 'mimeType: job.outputPublicUrl ? job.outputMimeType || "video/mp4"', "ready optimized creative is treated as video/mp4");
  assertSourceIncludes(source, 'job.thumbnailPublicUrl ? "worker"', "ready thumbnail source falls back to worker");
  assertSourceIncludes(source, "Итоговый размер:", "optimized output size shown when the job is ready");
  assertSourceIncludes(source, "меньше на ${Math.round((1 - videoJob.compressionRatio)", "compression ratio shown as a size reduction");
  assertSourceIncludes(source, 'optimized: creative?.fileType === "video" && videoJob?.status === "ready"', "launch payload flags optimized video output");
  assertSourceIncludes(source, "optimizedOutputSizeBytes: creative?.fileType === \"video\" ? videoJob?.outputSizeBytes", "launch payload carries optimized output size");
  assertSourceIncludes(source, "optimized_public_url present:", "admin details show optimized public URL presence");
  assertSourceIncludes(source, "thumbnail_url present:", "admin details show thumbnail URL presence");
  assertSourceIncludes(source, "output_size_bytes:", "admin details show optimized output size");
  assertSourceIncludes(source, "compression_ratio:", "admin details show compression ratio");
  assertSourceIncludes(source, "thumbnail_source: {videoJob.thumbnailSource", "admin details show thumbnail source");
  assertSourceIncludes(source, "raw deleted:", "admin details show raw deletion state");
  assertSourceIncludes(source, "Видео оптимизировано", "history marks optimized video launches");
  assertSourceExcludes(source, "rawBucket: \"ad-creatives-raw\"", "raw bucket value hardcoded in the UI");
  assertSourceExcludes(source, "ad-creatives-raw", "raw bucket name hardcoded in the UI");
  assertSourceExcludes(source, "SERVICE_ROLE", "service role key referenced in the frontend");
  assertSourceExcludes(source, "Следующим этапом будет добавлена", "stale future-optimization promise text");
  assertSourceIncludes(source, "Автоматическая оптимизация видео скоро будет доступна", "disabled optimization too-large message");
  assertSourceIncludes(source, "Видео большое. Для запуска рекламы его нужно оптимизировать.", "large video needs optimization client copy");
  assertSourceIncludes(source, "Следующим этапом система подготовит MP4-версию для Meta.", "future MP4 optimization copy");
  assertSourceIncludes(source, "video_optimization_required", "large video is not sent through direct upload when optimization is disabled");
  assertSourceIncludes(source, "creative.status === \"needs_optimization\"", "needs optimization readiness branch");
  assertSourceIncludes(source, '"config_loading"', "config loading readiness state");
  assertSourceIncludes(source, '"optimizing"', "optimizing readiness state");
  assertSourceIncludes(source, '"optimization_ready"', "optimization ready readiness state");
  assertSourceIncludes(source, '"optimization_failed"', "optimization failed readiness state");
  assertSourceIncludes(source, '"direct_upload_too_large_disabled"', "direct upload too large while disabled readiness state");
  assertSourceIncludes(source, "videoOptimizationLoaded", "videoOptimization.loaded debug field");
  assertSourceIncludes(source, "videoOptimization.loaded:", "videoOptimization.loaded visible in technical info");
  assertSourceIncludes(source, "configBlocked: videoConfigBlocked", "readiness receives the config-loading block flag");
  assertSourceIncludes(source, 'setVideoJob({ id: "local-failed", status: "failed"', "optimization branch failures are classified as optimization_failed");
  // D3C raw large-video upload polish (canonical /api/crm/video-jobs)
  assertSourceIncludes(source, '"/api/crm/video-jobs"', "large video uses the canonical video-jobs endpoint");
  assertSourceIncludes(source, "Видео загружено для оптимизации", "optimizing card title");
  assertSourceIncludes(source, "Мы подготовим MP4-версию для Meta. Запуск будет доступен после обработки.", "optimizing card body");
  assertSourceIncludes(source, "Запуск рекламы будет доступен после оптимизации.", "launch-after-optimization message");
  assertSourceIncludes(source, "Оптимизируем видео", "transcoding status label");
  assertSourceIncludes(source, "Подготовка файла", "downloading status label");
  assertSourceIncludes(source, "Сохраняем готовое видео", "uploading status label");
  assertSourceIncludes(source, "retryVideoJob", "retry handler exists");
  assertSourceIncludes(source, "Повторить обработку", "retry button label");
  assertSourceIncludes(source, "/api/crm/video-processing-jobs/${encodeURIComponent(jobId)}/retry", "retry uses the lower-level job endpoint");
  assertSourceIncludes(source, "jobId: {videoJob.id}", "admin job id detail");
  assertSourceIncludes(source, "rawPath: {uploadDebug.storagePath", "admin raw path detail");
  assertSourceIncludes(source, "inputSizeBytes: {creative.fileSize", "admin input size detail");
  // Client-mode safety: raw job details only inside the admin technical block.
  assertSourceIncludes(source, "isAdminMode && uploadDebug ?", "raw job details gated behind admin mode");

  console.log("AdsAutomation source checks: ok");
}

async function checkMetaMarketingSource() {
  const source = await readFile(path.join(repoRoot, "lib", "meta", "marketing.ts"), "utf8");
  const citiesSource = await readFile(path.join(repoRoot, "lib", "meta", "cities.ts"), "utf8");

  if (!source.includes("uploadMetaImageFromUrl")) {
    throw new Error("Meta marketing source is missing uploadMetaImageFromUrl");
  }
  if (!source.includes("/adimages")) {
    throw new Error("Meta marketing source is missing /adimages upload");
  }
  if (!source.includes("image_hash")) {
    throw new Error("Meta marketing source is missing image_hash creative flow");
  }
  if (!source.includes("buildImageLinkCreativePayload")) {
    throw new Error("Meta marketing source is missing explicit image link creative builder");
  }
  if (!source.includes("buildVideoCreativePayload")) {
    throw new Error("Meta marketing source is missing explicit video creative builder");
  }
  if (!source.includes("META_VIDEO_LAUNCH_DISABLED_MESSAGE")) {
    throw new Error("Meta marketing source must expose a controlled disabled message for video real launch");
  }
  if (!source.includes("META_VIDEO_LAUNCH_ENABLED")) {
    throw new Error("Meta marketing source must use META_VIDEO_LAUNCH_ENABLED feature flag");
  }
  if (!source.includes("uploadMetaVideoAndGetId")) {
    throw new Error("Meta marketing source is missing video_id upload flow");
  }
  if (!source.includes("/{adAccountId}/advideos") && !source.includes("`/${adAccountId}/advideos`")) {
    throw new Error("Meta marketing source must upload videos through /advideos");
  }
  if (!source.includes("pollMetaVideoProcessing")) {
    throw new Error("Meta video upload flow must poll processing status");
  }
  if (!source.includes("uploadMetaVideoBinary")) {
    throw new Error("Meta video upload flow must include binary fallback");
  }
  if (!source.includes("META_VIDEO_PROCESSING_TIMEOUT_MESSAGE")) {
    throw new Error("Meta video upload flow must return a controlled processing timeout message");
  }
  if (source.includes("status,processing_progress")) {
    throw new Error("Meta video polling must not request top-level processing_progress (Meta #100 nonexisting field)");
  }
  if (!source.includes("META_MOV_VIDEO_WARNING")) {
    throw new Error("Meta marketing source must warn but allow MOV");
  }
  if (!source.includes("buildImagePictureCreativePayload")) {
    throw new Error("Meta marketing source is missing picture URL fallback creative builder");
  }
  if (!source.includes("link_data:")) {
    throw new Error("Meta image creative source is missing object_story_spec.link_data");
  }
  if (!source.includes("video_data:")) {
    throw new Error("Meta video creative source is missing object_story_spec.video_data");
  }
  if (!source.includes("Meta image_hash не получен")) {
    throw new Error("Meta image creative source must fail clearly when image_hash is missing");
  }
  if (!source.includes("shouldFallbackImageUploadToPictureUrl")) {
    throw new Error("Meta marketing source is missing image upload capability fallback guard");
  }
  if (!source.includes('details.code === "3"')) {
    throw new Error("Meta image upload fallback must handle Meta code 3");
  }
  if (!source.includes("does not have the capability")) {
    throw new Error("Meta image upload fallback must handle capability errors");
  }
  if (!source.includes("picture: pictureUrl")) {
    throw new Error("Meta image fallback creative must use link_data.picture");
  }
  if (!source.includes("IMAGE_UPLOAD_CAPABILITY_FALLBACK_WARNING")) {
    throw new Error("Meta image upload fallback warning is missing");
  }
  if (source.includes('input.creativeType === "video" || input.videoId')) {
    throw new Error("Meta creative routing must not switch image assets into video path only because videoId exists");
  }
  if (source.includes('input.creativeType === "video" || input.videoUrl')) {
    throw new Error("Meta launch must not switch image assets into video path only because videoUrl exists");
  }
  if (!source.includes("META_VIDEO_LAUNCH_DISABLED_MESSAGE")) {
    throw new Error("Meta video real launch must return a controlled disabled message");
  }
  if (!source.includes("MetaApiError")) {
    throw new Error("Meta marketing source is missing detailed Meta API errors");
  }
  if (!source.includes("formatKazakhstanTimestamp")) {
    throw new Error("Meta marketing source is missing Kazakhstan launch timestamp helper");
  }
  if (!source.includes("resolveMetaTargetingForCity")) {
    throw new Error("Meta marketing source is missing city targeting resolver");
  }
  if (!source.includes("resolveMetaCityTarget")) {
    throw new Error("Meta marketing source is missing multi-city targeting resolver");
  }
  if (!source.includes("cityOptionMatchesCandidate")) {
    throw new Error("Meta marketing source is missing exact selected-city candidate matching");
  }
  if (!source.includes("readExactMetaCityFromSearch")) {
    throw new Error("Meta marketing source is missing exact Targeting Search candidate reader");
  }
  if (!citiesSource.includes("KZ_META_CITY_OPTIONS")) {
    throw new Error("Meta city options source is missing Kazakhstan city options");
  }
  if (!citiesSource.includes('id: "aktobe"') || !citiesSource.includes('id: "almaty"')) {
    throw new Error("Meta city options source must include Aktobe and Almaty");
  }
  if (!citiesSource.includes('metaKey: "1301648"')) {
    throw new Error("Meta city options source must keep Astana static city key 1301648");
  }
  if (!citiesSource.includes('metaKey: "1289458"')) {
    throw new Error("Meta city options source must keep Aktobe static city key 1289458");
  }
  if (!source.includes("metaCityTargetCache")) {
    throw new Error("Meta marketing source is missing city key cache");
  }
  if (!source.includes('type: "adgeolocation"') || !source.includes('location_types: ["city"]')) {
    throw new Error("Meta marketing source is missing Meta Targeting Search city fallback");
  }
  if (!source.includes("buildGeoLocations")) {
    throw new Error("Meta marketing source is missing geo location builder");
  }
  if (!source.includes("custom_locations")) {
    throw new Error("Meta marketing source must document custom_locations for future radius targeting");
  }
  if (source.includes("radius: 15") || source.includes('distance_unit: "kilometer"')) {
    throw new Error("Meta marketing source must not send radius/distance_unit for geo_locations.cities");
  }
  if (!source.includes('publisher_platforms: ["instagram"]')) {
    throw new Error("Meta marketing source must force Instagram-only publisher platforms");
  }
  if (!source.includes("instagram_positions: INSTAGRAM_POSITIONS")) {
    throw new Error("Meta marketing source must include Instagram positions in targeting");
  }
  if (!source.includes("INSTAGRAM_ACTOR_FALLBACK_WARNING")) {
    throw new Error("Meta marketing source is missing Instagram actor fallback warning");
  }
  if (!source.includes("shouldRetryWithoutInstagramActor")) {
    throw new Error("Meta marketing source is missing one-shot Instagram actor retry guard");
  }
  if (!source.includes("omitInstagramActor: true")) {
    throw new Error("Meta marketing source is missing creative retry without Instagram actor");
  }
  if (!source.includes('preparedInput.status === "PAUSED"')) {
    throw new Error("Meta marketing source must limit Instagram actor fallback to PAUSED launch");
  }
  if (!source.includes("instagram_actor_id: instagramActorId") && !source.includes("instagram_actor_id: input.instagramActorId")) {
    throw new Error("Meta marketing source is missing conditional instagram_actor_id payload");
  }
  if (!source.includes("creativeUsesInstagramActor")) {
    throw new Error("Meta marketing source is missing creativeUsesInstagramActor result flag");
  }
  if (!source.includes("is_adset_budget_sharing_enabled: false")) {
    throw new Error("Meta marketing source is missing campaign budget sharing opt-out");
  }
  if (!source.includes("daily_budget: String(dailyBudgetMinorUnits)")) {
    throw new Error("Meta marketing source is missing string ad set daily_budget");
  }
  if (!source.includes('optimization_goal: "LINK_CLICKS"')) {
    throw new Error("Meta marketing source must use LINK_CLICKS optimization for MVP ad sets");
  }
  if (!source.includes("targeting_automation:")) {
    throw new Error("Meta marketing source is missing targeting_automation inside targeting");
  }
  if (!source.includes("advantage_audience: 0")) {
    throw new Error("Meta marketing source is missing advantage_audience: 0");
  }
  if (!source.includes("Meta ad set payload missing daily_budget/lifetime_budget")) {
    throw new Error("Meta marketing source is missing ad set budget assertion");
  }
  if (!source.includes("serializeMetaFormPayload")) {
    throw new Error("Meta marketing source is missing explicit form serializer");
  }
  if (!source.includes("value !== undefined && value !== null")) {
    throw new Error("Meta marketing serializer must preserve false and numeric payload values");
  }
  if (!source.includes("typeof value === \"object\" ? JSON.stringify(value) : String(value)")) {
    throw new Error("Meta marketing serializer must JSON-serialize nested targeting");
  }
  if (source.includes(".filter(([, value]) => value)")) {
    throw new Error("Meta marketing serializer must not use truthy filtering");
  }
  if (!source.includes("META_VIDEO_THUMBNAIL_REQUIRED_MESSAGE")) {
    throw new Error("Meta marketing source must expose a controlled video thumbnail requirement message");
  }
  if (!source.includes("resolveVideoThumbnailUrl")) {
    throw new Error("Meta marketing source must normalize video thumbnail URLs before creative creation");
  }
  if (!source.includes("image_url: thumbnailUrl")) {
    throw new Error("Meta video creative must pass the generated thumbnail as video_data.image_url");
  }

  console.log("Meta marketing source checks: ok");
}

async function checkMetaCityResolverModule() {
  const moduleUrl = pathToFileURL(path.join(repoRoot, "lib", "meta", "marketing.ts")).href;
  const citiesModuleUrl = pathToFileURL(path.join(repoRoot, "lib", "meta", "cities.ts")).href;
  type SmokeMetaCityOption = {
    id: string;
    labelRu: string;
    labelEn: string;
    canonicalName: string;
    countryCode: "KZ";
    aliases: string[];
    metaKey?: string;
  };
  const marketing = (await import(moduleUrl)) as {
    resolveMetaCityTarget(city: string | SmokeMetaCityOption): Promise<{
      key: string | null;
      name?: string;
      source: string;
      warning?: string;
      selected?: { name?: string; key?: string } | null;
      candidates?: Array<{ name?: string; key?: string }>;
      rejectedCandidates?: Array<{ name?: string; key?: string; reason?: string }>;
    }>;
    resolveMetaTargetingForCity(city: string | SmokeMetaCityOption): Promise<{
      cityKey?: string;
      geoMode: string;
      fallbackCountry: boolean;
      source: string;
      warning?: string;
    }>;
    buildMetaAdSetPayload(input: Record<string, unknown>): Record<string, unknown>;
  };
  const cities = (await import(citiesModuleUrl)) as {
    getKzMetaCityOption(value: string): SmokeMetaCityOption;
    cityOptionMatchesCandidate(option: SmokeMetaCityOption, candidateName: string): boolean;
  };

  const originalEnv = {
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
    META_PAGE_ID: process.env.META_PAGE_ID,
    META_ASTANA_CITY_KEY: process.env.META_ASTANA_CITY_KEY,
  };
  const fetchBox = globalThis as unknown as {
    fetch: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
    }>;
  };
  const originalFetch = fetchBox.fetch;

  try {
    delete process.env.META_ASTANA_CITY_KEY;
    process.env.META_ACCESS_TOKEN = "smoke_token";
    process.env.META_AD_ACCOUNT_ID = "act_smoke";
    process.env.META_PAGE_ID = "page_smoke";
    fetchBox.fetch = async (input) => {
      const url = new URL(String(input));
      const query = (url.searchParams.get("q") || "").toLowerCase();
      const data = query.includes("almaty")
        ? [{ key: "almaty_test_city_key", name: "Almaty", type: "city", country_code: "KZ", supports_city: true }]
        : query.includes("aktobe")
          ? [
              { key: "temir_wrong_key", name: "Temir, Aqtöbe, Kazakhstan", type: "city", country_code: "KZ", supports_city: true },
              { key: "aktobe_exact_key", name: "Aktobe", type: "city", country_code: "KZ", supports_city: true },
            ]
          : [];
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data }),
      };
    };

    const astana = await marketing.resolveMetaCityTarget("Астана");
    if (astana.key !== "1301648" || astana.source !== "static") {
      throw new Error("resolveMetaCityTarget must resolve Astana from static map with key 1301648");
    }

    const almaty = await marketing.resolveMetaCityTarget("Алматы");
    if (almaty.key !== "almaty_test_city_key" || almaty.source !== "targeting_search") {
      throw new Error("resolveMetaCityTarget must resolve Almaty through mocked Targeting Search");
    }

    const almatyCached = await marketing.resolveMetaCityTarget("Almaty");
    if (almatyCached.key !== "almaty_test_city_key" || almatyCached.source !== "cache") {
      throw new Error("resolveMetaCityTarget must cache Targeting Search city keys");
    }

    const aktobeOption = cities.getKzMetaCityOption("aktobe");
    const aktobe = await marketing.resolveMetaCityTarget(aktobeOption);
    if (aktobe.key !== "1289458" || aktobe.source !== "static") {
      throw new Error("resolveMetaCityTarget must resolve Aktobe from static map with key 1289458");
    }
    if (cities.cityOptionMatchesCandidate(aktobeOption, "Temir, Aqtöbe, Kazakhstan")) {
      throw new Error("cityOptionMatchesCandidate must reject Temir when selected city is Aktobe");
    }
    if (!cities.cityOptionMatchesCandidate(aktobeOption, "Aktobe, Kazakhstan")) {
      throw new Error("cityOptionMatchesCandidate must accept exact Aktobe primary city name");
    }

    const unknown = await marketing.resolveMetaTargetingForCity("Unknown City");
    if (unknown.geoMode !== "country" || !unknown.fallbackCountry || !unknown.warning) {
      throw new Error("unknown city must fall back to Kazakhstan country targeting with warning");
    }

    const astanaTargeting = await marketing.resolveMetaTargetingForCity("Astana");
    const cityAdSet = marketing.buildMetaAdSetPayload({
      campaignName: "Smoke",
      campaignId: "campaign_1",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetMinor: 2000,
      currency: "USD",
      primaryText: "Text",
      headline: "Headline",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      city: "Astana",
      targetingResolution: astanaTargeting,
    });
    const cityTargeting = cityAdSet.targeting as { geo_locations?: { cities?: Array<{ key?: string; radius?: unknown; distance_unit?: unknown }> } };
    if (cityTargeting.geo_locations?.cities?.[0]?.key !== "1301648") {
      throw new Error("city targeting must use geo_locations.cities with the resolved Meta city key");
    }
    if (
      Object.prototype.hasOwnProperty.call(cityTargeting.geo_locations?.cities?.[0] || {}, "radius") ||
      Object.prototype.hasOwnProperty.call(cityTargeting.geo_locations?.cities?.[0] || {}, "distance_unit")
    ) {
      throw new Error("city targeting must not send radius or distance_unit for geo_locations.cities");
    }

    const aktobeTargeting = await marketing.resolveMetaTargetingForCity(aktobeOption);
    const aktobeAdSet = marketing.buildMetaAdSetPayload({
      campaignName: "Smoke Aktobe",
      campaignId: "campaign_aktobe",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetMinor: 2000,
      currency: "USD",
      primaryText: "Text",
      headline: "Headline",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      city: "Aktobe",
      targetingResolution: aktobeTargeting,
    });
    const aktobePayloadTargeting = aktobeAdSet.targeting as { geo_locations?: { countries?: unknown; cities?: Array<{ key?: string; radius?: unknown; distance_unit?: unknown }> } };
    const aktobeCity = aktobePayloadTargeting.geo_locations?.cities?.[0] || {};
    if (aktobeCity.key !== "1289458") {
      throw new Error("Aktobe city targeting must use static city key 1289458");
    }
    if (Object.prototype.hasOwnProperty.call(aktobeCity, "radius") || Object.prototype.hasOwnProperty.call(aktobeCity, "distance_unit")) {
      throw new Error("Aktobe city targeting must not include radius or distance_unit");
    }
    if (Object.prototype.hasOwnProperty.call(aktobePayloadTargeting.geo_locations || {}, "countries")) {
      throw new Error("Aktobe city targeting must not fallback to countries when city key is found");
    }

    const fallbackAdSet = marketing.buildMetaAdSetPayload({
      campaignName: "Smoke",
      campaignId: "campaign_1",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetMinor: 2000,
      currency: "USD",
      primaryText: "Text",
      headline: "Headline",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      city: "Unknown City",
      targetingResolution: unknown,
    });
    const fallbackTargeting = fallbackAdSet.targeting as { geo_locations?: { countries?: string[]; cities?: unknown[] } };
    if (JSON.stringify(fallbackTargeting.geo_locations?.countries) !== JSON.stringify(["KZ"]) || fallbackTargeting.geo_locations?.cities) {
      throw new Error("fallback targeting must use geo_locations.countries [\"KZ\"]");
    }
  } finally {
    fetchBox.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("Meta city resolver module checks: ok");
}

async function checkMetaVideoModule() {
  const moduleUrl = pathToFileURL(path.join(repoRoot, "lib", "meta", "marketing.ts")).href;
  const marketing = (await import(moduleUrl)) as {
    uploadMetaVideoAndGetId(input: {
      videoUrl: string;
      fileName?: string;
      mimeType?: string;
      title?: string;
      processingPollAttempts?: number;
      processingPollDelayMs?: number;
    }): Promise<{ videoId: string; uploadMode: string; processingStatus?: string; warnings?: string[] }>;
    launchMetaCampaign(input: Record<string, unknown>): Promise<{ videoId?: string; videoUploadMode?: string; videoProcessingStatus?: string; metaCampaignId?: string; creativeUsesVideoData?: boolean; creativeUsesLinkData?: boolean }>;
    buildVideoCreativePayload(input: Record<string, unknown>): Record<string, unknown>;
    buildImageLinkCreativePayload(input: Record<string, unknown>): Record<string, unknown>;
    isSupportedMetaVideoFormat(input: { mimeType?: string; fileName?: string }): boolean;
  };

  const originalEnv = {
    META_VIDEO_LAUNCH_ENABLED: process.env.META_VIDEO_LAUNCH_ENABLED,
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
    META_PAGE_ID: process.env.META_PAGE_ID,
    META_INSTAGRAM_ACTOR_ID: process.env.META_INSTAGRAM_ACTOR_ID,
  };
  const fetchBox = globalThis as unknown as {
    fetch: (
      input: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer },
    ) => Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      headers?: { get(name: string): string | null };
      arrayBuffer?: () => Promise<ArrayBuffer>;
    }>;
  };
  const originalFetch = fetchBox.fetch;
  const calls: Array<{ url: string; method: string; body: string }> = [];

  const jsonResponse = (data: unknown) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
  });

  try {
    process.env.META_VIDEO_LAUNCH_ENABLED = "false";
    fetchBox.fetch = async () => {
      throw new Error("Meta API must not be called while video launch flag is disabled");
    };
    for (const file of [
      { fileName: "disabled.mp4", mimeType: "video/mp4", videoUrl: "https://example.com/disabled.mp4" },
      { fileName: "disabled.mov", mimeType: "video/quicktime", videoUrl: "https://example.com/disabled.mov" },
    ]) {
      let blocked = false;
      try {
        await marketing.launchMetaCampaign({
          campaignName: "Disabled Video Launch",
          objective: "OUTCOME_LEADS",
          status: "PAUSED",
          dailyBudgetMinor: 2000,
          currency: "USD",
          primaryText: "Text",
          headline: "Headline",
          description: "Description",
          cta: "LEARN_MORE",
          landingUrl: "https://example.com",
          creativeType: "video",
          ...file,
        });
      } catch (error) {
        blocked = error instanceof Error && error.message.includes("подготовке");
      }
      if (!blocked) {
        throw new Error("MP4/MOV real launch must be blocked while META_VIDEO_LAUNCH_ENABLED=false");
      }
    }

    process.env.META_VIDEO_LAUNCH_ENABLED = "true";
    process.env.META_ACCESS_TOKEN = "smoke_token";
    process.env.META_AD_ACCOUNT_ID = "act_smoke";
    process.env.META_PAGE_ID = "page_smoke";
    delete process.env.META_INSTAGRAM_ACTOR_ID;

    fetchBox.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      const body = typeof init.body === "string" ? init.body : Buffer.isBuffer(init.body) ? init.body.toString("utf8") : "";
      calls.push({ url, method, body });

      if (url.includes("/advideos") && method === "POST") {
        const params = new URLSearchParams(body);
        const fileUrl = params.get("file_url") || "";
        if (fileUrl.includes("pending")) return jsonResponse({ id: "video_pending" });
        if (fileUrl.includes("mov")) return jsonResponse({ id: "video_mov" });
        return jsonResponse({ id: "video_launch" });
      }
      if (url.includes("/video_pending")) {
        if (url.includes("processing_progress")) {
          throw new Error("video polling must not request top-level processing_progress field");
        }
        return jsonResponse({ status: { video_status: "processing", processing_progress: 25 } });
      }
      if (url.includes("/video_mov")) {
        return jsonResponse({ status: { video_status: "ready", processing_progress: 100 } });
      }
      if (url.includes("/video_launch")) {
        return jsonResponse({ status: { video_status: "ready" } });
      }
      if (url.includes("/campaigns") && method === "POST") return jsonResponse({ id: "campaign_smoke" });
      if (url.includes("/adsets") && method === "POST") {
        const params = new URLSearchParams(body);
        const targeting = JSON.parse(params.get("targeting") || "{}") as { publisher_platforms?: string[]; instagram_positions?: string[] };
        if (JSON.stringify(targeting.publisher_platforms || []) !== JSON.stringify(["instagram"])) {
          throw new Error("video launch adset must preserve Instagram-only publisher platforms");
        }
        if (!["stream", "story", "explore", "reels"].every((position) => (targeting.instagram_positions || []).includes(position))) {
          throw new Error("video launch adset must preserve Instagram positions");
        }
        return jsonResponse({ id: "adset_smoke" });
      }
      if (url.includes("/adcreatives") && method === "POST") {
        const params = new URLSearchParams(body);
        const spec = JSON.parse(params.get("object_story_spec") || "{}") as {
          video_data?: { video_id?: string; image_url?: string };
          link_data?: unknown;
        };
        if (spec.video_data?.video_id !== "video_launch") {
          throw new Error("video launch creative must use object_story_spec.video_data.video_id");
        }
        if (spec.link_data) {
          throw new Error("video launch creative must not use link_data");
        }
        if (spec.video_data?.image_url !== "https://example.com/smoke-thumb.jpg") {
          throw new Error("video launch creative must pass the generated thumbnail as video_data.image_url");
        }
        if ((spec.video_data?.image_url || "").endsWith(".mp4")) {
          throw new Error("video launch creative must never use the video public URL as image_url");
        }
        return jsonResponse({ id: "creative_smoke" });
      }
      if (url.includes("/ads") && method === "POST") return jsonResponse({ id: "ad_smoke" });

      return jsonResponse({});
    };

    if (!marketing.isSupportedMetaVideoFormat({ fileName: "smoke.mp4", mimeType: "video/mp4" })) {
      throw new Error("MP4 must be supported for Meta video launch");
    }
    if (!marketing.isSupportedMetaVideoFormat({ fileName: "smoke.mov", mimeType: "video/quicktime" })) {
      throw new Error("MOV must be supported for Meta video launch");
    }
    if (marketing.isSupportedMetaVideoFormat({ fileName: "smoke.webm", mimeType: "video/webm" })) {
      throw new Error("WEBM must not be supported for real Meta video launch");
    }

    const movUpload = await marketing.uploadMetaVideoAndGetId({
      videoUrl: "https://example.com/smoke.mov",
      fileName: "smoke.mov",
      mimeType: "video/quicktime",
      title: "MOV Smoke",
      processingPollAttempts: 1,
      processingPollDelayMs: 0,
    });
    if (movUpload.videoId !== "video_mov" || movUpload.uploadMode !== "file_url" || !movUpload.warnings?.some((item) => item.includes("MOV"))) {
      throw new Error("MOV upload must return video_id, file_url mode, and a warning");
    }

    let processingTimeout = false;
    let pendingDetails: { pending?: boolean; debug?: { videoId?: string; status?: string } } | undefined;
    try {
      await marketing.uploadMetaVideoAndGetId({
        videoUrl: "https://example.com/pending.mp4",
        fileName: "pending.mp4",
        mimeType: "video/mp4",
        title: "Pending Smoke",
        processingPollAttempts: 1,
        processingPollDelayMs: 0,
      });
    } catch (error) {
      processingTimeout = error instanceof Error && error.message.includes("обрабатывается");
      pendingDetails = (error as { details?: { pending?: boolean; debug?: { videoId?: string; status?: string } } }).details;
    }
    if (!processingTimeout) {
      throw new Error("video processing timeout must return a controlled retry message");
    }
    if (pendingDetails?.pending !== true) {
      throw new Error("video processing timeout must be marked pending, not a real failure");
    }
    if (pendingDetails?.debug?.videoId !== "video_pending") {
      throw new Error("video processing timeout must preserve the received Meta video_id in debug");
    }

    const videoCreative = marketing.buildVideoCreativePayload({
      campaignName: "Smoke",
      creativeName: "Smoke Video Creative",
      pageId: "page_smoke",
      videoId: "video_123",
      headline: "Headline",
      primaryText: "Text",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
    });
    const videoSpec = videoCreative.object_story_spec as { video_data?: { video_id?: string; image_url?: string }; link_data?: unknown };
    if (videoSpec.video_data?.video_id !== "video_123" || videoSpec.link_data) {
      throw new Error("video creative payload must use video_data.video_id and must not use link_data");
    }
    if (Object.prototype.hasOwnProperty.call(videoSpec.video_data || {}, "image_url")) {
      throw new Error("video creative payload without thumbnail must not invent image_url");
    }

    const videoCreativeWithThumb = marketing.buildVideoCreativePayload({
      campaignName: "Smoke",
      creativeName: "Smoke Video Creative",
      pageId: "page_smoke",
      videoId: "video_123",
      headline: "Headline",
      primaryText: "Text",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      videoUrl: "https://example.com/video.mp4",
      thumbnailUrl: "https://example.com/thumb.jpg",
    });
    const thumbSpec = videoCreativeWithThumb.object_story_spec as { video_data?: { image_url?: string } };
    if (thumbSpec.video_data?.image_url !== "https://example.com/thumb.jpg") {
      throw new Error("video creative payload must pass thumbnailUrl as video_data.image_url");
    }

    const videoCreativeVideoAsThumb = marketing.buildVideoCreativePayload({
      campaignName: "Smoke",
      creativeName: "Smoke Video Creative",
      pageId: "page_smoke",
      videoId: "video_123",
      headline: "Headline",
      primaryText: "Text",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      videoUrl: "https://example.com/video.mp4",
      thumbnailUrl: "https://example.com/video.mp4",
    });
    const videoAsThumbSpec = videoCreativeVideoAsThumb.object_story_spec as { video_data?: { image_url?: string } };
    if (Object.prototype.hasOwnProperty.call(videoAsThumbSpec.video_data || {}, "image_url")) {
      throw new Error("video creative payload must never use the video public URL as image_url");
    }

    const imageCreative = marketing.buildImageLinkCreativePayload({
      campaignName: "Smoke",
      creativeName: "Smoke Image Creative",
      pageId: "page_smoke",
      imageHash: "image_hash_123",
      headline: "Headline",
      primaryText: "Text",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
    });
    const imageSpec = imageCreative.object_story_spec as { link_data?: { image_hash?: string }; video_data?: unknown };
    if (imageSpec.link_data?.image_hash !== "image_hash_123" || imageSpec.video_data) {
      throw new Error("image creative payload must still use link_data.image_hash and must not use video_data");
    }

    const launch = await marketing.launchMetaCampaign({
      campaignName: "Smoke Video Launch",
      objective: "OUTCOME_LEADS",
      status: "PAUSED",
      dailyBudgetMinor: 2000,
      currency: "USD",
      primaryText: "Text",
      headline: "Headline",
      description: "Description",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      creativeType: "video",
      videoUrl: "https://example.com/smoke.mp4",
      thumbnailUrl: "https://example.com/smoke-thumb.jpg",
      fileName: "smoke.mp4",
      mimeType: "video/mp4",
      city: "Astana",
    });
    if (launch.videoId !== "video_launch" || launch.videoUploadMode !== "file_url" || launch.videoProcessingStatus !== "ready") {
      throw new Error("real video launch must upload video and expose video_id/upload mode/processing status");
    }
    if (launch.metaCampaignId !== "campaign_smoke" || launch.creativeUsesVideoData !== true || launch.creativeUsesLinkData !== false) {
      throw new Error("real video launch must continue through PAUSED campaign/adset/creative/ad creation");
    }
    if (!calls.some((call) => call.url.includes("/advideos")) || !calls.some((call) => call.url.includes("/adcreatives"))) {
      throw new Error("real video launch must call advideos and adcreatives");
    }

    // Missing thumbnail must block before the Meta creative call with a controlled message.
    calls.length = 0;
    let thumbnailBlocked = false;
    try {
      await marketing.launchMetaCampaign({
        campaignName: "Smoke Video Launch No Thumb",
        objective: "OUTCOME_LEADS",
        status: "PAUSED",
        dailyBudgetMinor: 2000,
        currency: "USD",
        primaryText: "Text",
        headline: "Headline",
        description: "Description",
        cta: "LEARN_MORE",
        landingUrl: "https://example.com",
        creativeType: "video",
        videoUrl: "https://example.com/smoke.mp4",
        fileName: "smoke.mp4",
        mimeType: "video/mp4",
        city: "Astana",
      });
    } catch (error) {
      thumbnailBlocked = error instanceof Error && error.message.includes("обложка");
    }
    if (!thumbnailBlocked) {
      throw new Error("video launch without thumbnail must fail with the controlled thumbnail message");
    }
    if (calls.some((call) => call.url.includes("/adcreatives"))) {
      throw new Error("missing thumbnail must block before the Meta creative call");
    }
  } finally {
    fetchBox.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("Meta video module checks: ok");
}

async function checkCrmLaunchStateModule() {
  const crmModuleUrl = pathToFileURL(path.join(repoRoot, "lib", "crm", "server.ts")).href;
  const crm = (await import(crmModuleUrl)) as {
    handleMetaLaunch(req: unknown, res: unknown): Promise<unknown>;
    handleAdCreativeMetaUpload(req: unknown, res: unknown): Promise<unknown>;
  };

  const originalEnv = {
    META_VIDEO_LAUNCH_ENABLED: process.env.META_VIDEO_LAUNCH_ENABLED,
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_AD_ACCOUNT_ID: process.env.META_AD_ACCOUNT_ID,
    META_PAGE_ID: process.env.META_PAGE_ID,
    META_INSTAGRAM_ACTOR_ID: process.env.META_INSTAGRAM_ACTOR_ID,
    META_VIDEO_PROCESSING_POLL_ATTEMPTS: process.env.META_VIDEO_PROCESSING_POLL_ATTEMPTS,
    META_VIDEO_PROCESSING_POLL_DELAY_MS: process.env.META_VIDEO_PROCESSING_POLL_DELAY_MS,
  };
  const fetchBox = globalThis as unknown as {
    fetch: (
      input: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer },
    ) => Promise<{
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      headers?: { get(name: string): string | null };
      arrayBuffer?: () => Promise<ArrayBuffer>;
    }>;
  };
  const originalFetch = fetchBox.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  const jsonResponse = (data: unknown) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
  });

  const makeRes = () => {
    const box: { statusCode: number; body: Record<string, unknown> } = { statusCode: 0, body: {} };
    const res = {
      status(code: number) {
        box.statusCode = code;
        return res;
      },
      setHeader() {
        return res;
      },
      json(payload: unknown) {
        box.body = (payload || {}) as Record<string, unknown>;
        return res;
      },
      end() {
        return res;
      },
    };
    return { res, box };
  };

  const baseLaunchBody = {
    workspaceId: "demo-workspace",
    campaignName: "Smoke CRM Video Launch",
    objective: "OUTCOME_LEADS",
    statusMode: "PAUSED",
    dailyBudget: 20,
    totalBudget: 140,
    currency: "USD",
    city: "Astana",
    targetAudience: "Women 25-55",
    primaryText: "Professional consultation in Astana. Book a specialist consultation.",
    headline: "Consultation in Astana",
    description: "Book a consultation with a specialist.",
    cta: "LEARN_MORE",
    landingUrl: "https://example.com",
    creativeType: "video",
    creativeUrl: "https://example.com/crm-pending.mp4",
    videoUrl: "https://example.com/crm-pending.mp4",
    thumbnailUrl: "https://example.com/crm-thumb.jpg",
    fileName: "crm-pending.mp4",
    mimeType: "video/mp4",
    complianceConfirmed: true,
    manualApprovalConfirmed: true,
    dryRun: false,
  };

  try {
    process.env.META_VIDEO_LAUNCH_ENABLED = "true";
    process.env.META_ACCESS_TOKEN = "smoke_token";
    process.env.META_AD_ACCOUNT_ID = "act_smoke";
    process.env.META_PAGE_ID = "page_smoke";
    delete process.env.META_INSTAGRAM_ACTOR_ID;
    process.env.META_VIDEO_PROCESSING_POLL_ATTEMPTS = "1";
    process.env.META_VIDEO_PROCESSING_POLL_DELAY_MS = "0";

    fetchBox.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      calls.push({ url, method });
      if (url.includes("/advideos") && method === "POST") return jsonResponse({ id: "video_pending_crm" });
      if (url.includes("/video_pending_crm")) return jsonResponse({ status: { video_status: "processing", processing_progress: 40 } });
      if (url.includes("/video_ready_crm")) return jsonResponse({ status: { video_status: "ready" } });
      return jsonResponse({});
    };

    // Real video launch without a thumbnail must be blocked by validation before any Meta call.
    const missingThumb = makeRes();
    await crm.handleMetaLaunch({ method: "POST", body: { ...baseLaunchBody, thumbnailUrl: "" }, query: {}, headers: {} }, missingThumb.res);
    const missingThumbBody = missingThumb.box.body as { success?: boolean; details?: string[] };
    if (missingThumb.box.statusCode !== 400 || missingThumbBody.success !== false || !(missingThumbBody.details || []).some((item) => item.includes("обложка"))) {
      throw new Error("real video launch without thumbnail must be blocked with the controlled thumbnail message");
    }
    if (calls.length > 0) {
      throw new Error("missing thumbnail must block before any Meta API call");
    }

    // The video public URL must never be accepted as the thumbnail.
    const videoAsThumb = makeRes();
    await crm.handleMetaLaunch(
      { method: "POST", body: { ...baseLaunchBody, thumbnailUrl: baseLaunchBody.videoUrl }, query: {}, headers: {} },
      videoAsThumb.res,
    );
    const videoAsThumbBody = videoAsThumb.box.body as { success?: boolean; details?: string[] };
    if (videoAsThumb.box.statusCode !== 400 || videoAsThumbBody.success !== false || !(videoAsThumbBody.details || []).some((item) => item.includes("обложка"))) {
      throw new Error("video public URL must not be accepted as video thumbnail");
    }
    if (calls.length > 0) {
      throw new Error("video-as-thumbnail must block before any Meta API call");
    }

    // Real video launch with pending Meta processing must become video_processing, not PAUSED and not failed.
    const pendingLaunch = makeRes();
    await crm.handleMetaLaunch({ method: "POST", body: { ...baseLaunchBody }, query: {}, headers: {} }, pendingLaunch.res);
    const pendingBody = pendingLaunch.box.body as {
      success?: boolean;
      data?: { status?: string; metaVideoId?: string; launch?: { status?: string; metaVideoId?: string; lastError?: string } };
    };
    if (pendingLaunch.box.statusCode !== 202 || pendingBody.success !== true) {
      throw new Error("meta-launch with pending video processing must return 202 success, not a failure");
    }
    if (pendingBody.data?.status !== "video_processing" || pendingBody.data?.metaVideoId !== "video_pending_crm") {
      throw new Error("meta-launch pending video must report status video_processing with the Meta video_id");
    }
    if (pendingBody.data?.launch?.status !== "video_processing" || pendingBody.data?.launch?.metaVideoId !== "video_pending_crm") {
      throw new Error("meta-launch pending video history record must keep status video_processing and the video_id");
    }
    if (pendingBody.data?.launch?.lastError) {
      throw new Error("meta-launch pending video must not be recorded as failed");
    }
    if (calls.some((call) => call.url.includes("/campaigns"))) {
      throw new Error("meta-launch must not create a campaign while the video is still processing");
    }

    // A stored video_id must be reused: status re-check only, no second /advideos upload.
    calls.length = 0;
    const reuse = makeRes();
    await crm.handleAdCreativeMetaUpload(
      {
        method: "POST",
        body: { workspaceId: "demo-workspace", fileType: "video", fileName: "crm-pending.mp4", mimeType: "video/mp4", metaVideoId: "video_ready_crm" },
        query: {},
        headers: {},
      },
      reuse.res,
    );
    const reuseBody = reuse.box.body as {
      success?: boolean;
      data?: { metaVideoId?: string; reused?: boolean; videoReady?: boolean; lastCheckedAt?: string };
    };
    if (
      reuse.box.statusCode !== 200 ||
      reuseBody.success !== true ||
      reuseBody.data?.metaVideoId !== "video_ready_crm" ||
      reuseBody.data?.reused !== true ||
      reuseBody.data?.videoReady !== true
    ) {
      throw new Error("ad-creative-meta-upload must reuse an existing Meta video_id and report readiness");
    }
    if (!reuseBody.data?.lastCheckedAt) {
      throw new Error("ad-creative-meta-upload recheck must report lastCheckedAt");
    }
    if (calls.some((call) => call.url.includes("/advideos"))) {
      throw new Error("ad-creative-meta-upload must not upload the video again when video_id is already known");
    }

    // Rechecking a still-processing video stays video_processing and is not an error.
    calls.length = 0;
    const stillProcessing = makeRes();
    await crm.handleAdCreativeMetaUpload(
      {
        method: "POST",
        body: { workspaceId: "demo-workspace", fileType: "video", fileName: "crm-pending.mp4", mimeType: "video/mp4", metaVideoId: "video_pending_crm" },
        query: {},
        headers: {},
      },
      stillProcessing.res,
    );
    const stillBody = stillProcessing.box.body as {
      success?: boolean;
      data?: { status?: string; videoReady?: boolean; metaVideoId?: string };
    };
    if (
      stillProcessing.box.statusCode !== 202 ||
      stillBody.success !== true ||
      stillBody.data?.status !== "video_processing" ||
      stillBody.data?.videoReady !== false ||
      stillBody.data?.metaVideoId !== "video_pending_crm"
    ) {
      throw new Error("ad-creative-meta-upload recheck of a processing video must stay video_processing without failing");
    }

    // ACTIVE launch must remain gated.
    const gated = makeRes();
    await crm.handleMetaLaunch(
      {
        method: "POST",
        body: {
          ...baseLaunchBody,
          creativeType: "image",
          imageUrl: "https://example.com/smoke.jpg",
          creativeUrl: "https://example.com/smoke.jpg",
          videoUrl: "",
          fileName: "smoke.jpg",
          mimeType: "image/jpeg",
          statusMode: "ACTIVE",
        },
        query: {},
        headers: {},
      },
      gated.res,
    );
    const gatedBody = gated.box.body as { success?: boolean; details?: string[] };
    if (gated.box.statusCode < 400 || gatedBody.success !== false || !(gatedBody.details || []).some((item) => item.includes("ACTIVE"))) {
      throw new Error("ACTIVE launch must remain gated without Admin Center live launch approval");
    }
  } finally {
    fetchBox.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("CRM launch state module checks: ok");
}

async function checkCrmVideoJobsModule() {
  const crmModuleUrl = pathToFileURL(path.join(repoRoot, "lib", "crm", "server.ts")).href;
  const crm = (await import(crmModuleUrl)) as {
    handleVideoJobs(req: unknown, res: unknown): Promise<unknown>;
    handleVideoProcessingJobs(req: unknown, res: unknown, pathSegments?: string[]): Promise<unknown>;
    videoOptimizationConfig(): { enabled: boolean; thresholdMb: number; maxInputMb: number };
  };

  const originalEnv = {
    VIDEO_OPTIMIZATION_ENABLED: process.env.VIDEO_OPTIMIZATION_ENABLED,
    VIDEO_OPTIMIZATION_THRESHOLD_MB: process.env.VIDEO_OPTIMIZATION_THRESHOLD_MB,
    VIDEO_OPTIMIZATION_MAX_INPUT_MB: process.env.VIDEO_OPTIMIZATION_MAX_INPUT_MB,
    VIDEO_OPTIMIZATION_RAW_BUCKET: process.env.VIDEO_OPTIMIZATION_RAW_BUCKET,
    VIDEO_OPTIMIZATION_WORKER_SECRET: process.env.VIDEO_OPTIMIZATION_WORKER_SECRET,
  };

  const makeRes = () => {
    const box: { statusCode: number; body: Record<string, unknown> } = { statusCode: 0, body: {} };
    const res = {
      status(code: number) {
        box.statusCode = code;
        return res;
      },
      setHeader() {
        return res;
      },
      json(payload: unknown) {
        box.body = (payload || {}) as Record<string, unknown>;
        return res;
      },
      end() {
        return res;
      },
    };
    return { res, box };
  };

  try {
    delete process.env.VIDEO_OPTIMIZATION_ENABLED;
    delete process.env.VIDEO_OPTIMIZATION_THRESHOLD_MB;
    delete process.env.VIDEO_OPTIMIZATION_MAX_INPUT_MB;
    delete process.env.VIDEO_OPTIMIZATION_RAW_BUCKET;
    delete process.env.VIDEO_OPTIMIZATION_WORKER_SECRET;

    // Defaults: optimization is off, threshold 50 MB, max input 500 MB.
    const defaults = crm.videoOptimizationConfig();
    if (defaults.enabled !== false || defaults.thresholdMb !== 50 || defaults.maxInputMb !== 500) {
      throw new Error("video optimization config must default to disabled with 50/500 MB limits");
    }
    if (!("rawBucket" in defaults) || (defaults as { rawBucket?: string }).rawBucket !== "ad-creatives-raw") {
      throw new Error("video optimization config must expose the safe raw bucket default");
    }

    // Flag off: creating jobs must be blocked with a controlled message.
    const blocked = makeRes();
    await crm.handleVideoJobs(
      { method: "POST", body: { workspaceId: "demo-workspace", fileName: "big.mp4", mimeType: "video/mp4", fileSize: 200 * 1024 * 1024 }, query: {}, headers: {} },
      blocked.res,
    );
    const blockedBody = blocked.box.body as { success?: boolean; details?: string[] };
    if (blocked.box.statusCode !== 409 || blockedBody.success !== false || !(blockedBody.details || []).some((item) => item.includes("Оптимизация"))) {
      throw new Error("video-jobs POST must be blocked while VIDEO_OPTIMIZATION_ENABLED is off");
    }

    process.env.VIDEO_OPTIMIZATION_ENABLED = "true";

    // Oversized input must be rejected before any storage work.
    const tooLarge = makeRes();
    await crm.handleVideoJobs(
      { method: "POST", body: { workspaceId: "demo-workspace", fileName: "huge.mp4", mimeType: "video/mp4", fileSize: 501 * 1024 * 1024 }, query: {}, headers: {} },
      tooLarge.res,
    );
    const tooLargeBody = tooLarge.box.body as { success?: boolean; details?: string[] };
    if (tooLarge.box.statusCode !== 400 || tooLargeBody.success !== false || !(tooLargeBody.details || []).some((item) => item.includes("500 MB"))) {
      throw new Error("video-jobs POST must reject inputs above VIDEO_OPTIMIZATION_MAX_INPUT_MB");
    }

    // New jobs start as awaiting_upload — never queued before the raw upload finishes.
    const created = makeRes();
    await crm.handleVideoJobs(
      { method: "POST", body: { workspaceId: "demo-workspace", fileName: "big.mp4", mimeType: "video/mp4", fileSize: 200 * 1024 * 1024 }, query: {}, headers: {} },
      created.res,
    );
    const createdBody = created.box.body as { success?: boolean; data?: { job?: Record<string, unknown> } };
    const createdJob = createdBody.data?.job || {};
    // Jobs must be created as awaiting_upload — never directly as queued.
    if (createdBody.success !== true || createdJob.status !== "awaiting_upload") {
      throw new Error("video-jobs POST must create the job as awaiting_upload, not queued");
    }

    // PATCH confirms the raw upload and moves the job to queued.
    const patched = makeRes();
    await crm.handleVideoJobs(
      { method: "PATCH", body: { id: String(createdJob.id || "job-smoke"), workspaceId: "demo-workspace", rawSize: 200 * 1024 * 1024 }, query: {}, headers: {} },
      patched.res,
    );
    const patchedBody = patched.box.body as { success?: boolean; data?: { job?: Record<string, unknown> } };
    if (patchedBody.success !== true || patchedBody.data?.job?.status !== "queued") {
      throw new Error("video-jobs PATCH must move awaiting_upload jobs to queued");
    }

    // GET returns a safe polling shape without raw storage internals or worker claim data.
    const polled = makeRes();
    await crm.handleVideoJobs({ method: "GET", body: {}, query: { id: "job-smoke", workspaceId: "demo-workspace" }, headers: {} }, polled.res);
    const polledBody = polled.box.body as { success?: boolean; data?: { job?: Record<string, unknown> } };
    const polledJob = polledBody.data?.job || {};
    if (polledBody.success !== true || !polledJob.status) {
      throw new Error("video-jobs GET must return a job status for polling");
    }
    for (const forbidden of ["rawPath", "raw_path", "rawBucket", "raw_bucket", "claimedBy", "claimed_by", "rawPublicUrl", "raw_public_url"]) {
      if (Object.prototype.hasOwnProperty.call(polledJob, forbidden)) {
        throw new Error(`video-jobs GET must not expose ${forbidden}`);
      }
    }

    // Public foundation contract: create/get/retry via /api/crm/video-processing-jobs.
    const foundationCreated = makeRes();
    await crm.handleVideoProcessingJobs(
      {
        method: "POST",
        body: {
          workspaceId: "demo-workspace",
          fileName: "large.mov",
          inputMimeType: "video/quicktime",
          inputSizeBytes: 120 * 1024 * 1024,
          rawPath: "private/raw/large.mov",
          rawPublicUrl: "https://example.com/should-not-be-exposed.mov",
        },
        query: {},
        headers: {},
      },
      foundationCreated.res,
      [],
    );
    const foundationCreatedBody = foundationCreated.box.body as { success?: boolean; data?: { job?: Record<string, unknown> } };
    const foundationJob = foundationCreatedBody.data?.job || {};
    if (foundationCreatedBody.success !== true || foundationJob.status !== "queued" || foundationJob.inputSizeBytes !== 120 * 1024 * 1024) {
      throw new Error("video-processing-jobs POST must create a queued safe job response");
    }
    for (const forbidden of ["rawPath", "raw_path", "rawBucket", "raw_bucket", "rawPublicUrl", "raw_public_url", "claimedBy", "claimed_by"]) {
      if (Object.prototype.hasOwnProperty.call(foundationJob, forbidden)) {
        throw new Error(`video-processing-jobs POST must not expose ${forbidden}`);
      }
    }

    const foundationPolled = makeRes();
    await crm.handleVideoProcessingJobs({ method: "GET", body: {}, query: {}, headers: {} }, foundationPolled.res, [String(foundationJob.id || "job-smoke")]);
    const foundationPolledBody = foundationPolled.box.body as { success?: boolean; data?: { job?: Record<string, unknown> } };
    if (foundationPolledBody.success !== true || !foundationPolledBody.data?.job?.status) {
      throw new Error("video-processing-jobs GET must return safe job status");
    }

    const retryReady = makeRes();
    await crm.handleVideoProcessingJobs({ method: "POST", body: { status: "ready" }, query: {}, headers: {} }, retryReady.res, ["ready-job", "retry"]);
    if (retryReady.box.statusCode !== 409) {
      throw new Error("video-processing-jobs retry must reject non-failed jobs");
    }

    const retryFailed = makeRes();
    await crm.handleVideoProcessingJobs({ method: "POST", body: { status: "failed" }, query: {}, headers: {} }, retryFailed.res, ["failed-job", "retry"]);
    const retryFailedBody = retryFailed.box.body as { success?: boolean; data?: { job?: Record<string, unknown> } };
    if (retryFailedBody.success !== true || retryFailedBody.data?.job?.status !== "queued" || retryFailedBody.data?.job?.progress !== 0) {
      throw new Error("video-processing-jobs retry must reset failed jobs to queued");
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  console.log("CRM video jobs module checks: ok");
}

async function checkVideoWorkerPackage() {
  const workerDir = path.join(repoRoot, "artifacts", "video-worker");

  const pkg = JSON.parse(await readFile(path.join(workerDir, "package.json"), "utf8")) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  if (pkg.name !== "@workspace/video-worker") {
    throw new Error("video worker package must be named @workspace/video-worker");
  }
  for (const script of ["dev", "build", "start", "typecheck"]) {
    if (!pkg.scripts?.[script]) {
      throw new Error(`video worker package must define the ${script} script`);
    }
  }

  // Railway builds the worker with root directory artifacts/video-worker:
  // nothing may reference files outside the package (root tsconfig, workspace deps).
  const workerTsconfig = await readFile(path.join(workerDir, "tsconfig.json"), "utf8");
  if (workerTsconfig.includes("extends") || workerTsconfig.includes("tsconfig.base")) {
    throw new Error("video worker tsconfig must be standalone and not extend the root tsconfig.base.json");
  }
  const workerPackageJson = await readFile(path.join(workerDir, "package.json"), "utf8");
  if (workerPackageJson.includes("workspace:") || workerPackageJson.includes("catalog:")) {
    throw new Error("video worker package must not use workspace or catalog dependencies");
  }
  const workerDependencies = (JSON.parse(workerPackageJson) as { dependencies?: Record<string, string> }).dependencies || {};
  if (!workerDependencies.ws) {
    throw new Error("video worker must depend on ws for the Node 20 Supabase realtime transport");
  }

  const ffmpegSource = await readFile(path.join(workerDir, "src", "ffmpeg.ts"), "utf8");
  for (const marker of ["libx264", '"aac"', "+faststart", "-map_metadata", "':-2", "fps=${options.fps}"]) {
    if (!ffmpegSource.includes(marker)) {
      throw new Error(`video worker ffmpeg source is missing ${marker}`);
    }
  }

  const workerSource = await readFile(path.join(workerDir, "src", "worker.ts"), "utf8");
  for (const marker of [
    '.eq("status", "queued")',
    "claimed_by",
    "claimed_at",
    "attempts",
    "output_public_url",
    "optimized_public_url",
    "thumbnail_public_url",
    "thumbnail_url",
    'thumbnail_source: "worker"',
    'status: "ready"',
    'status: "failed"',
    "raw_deleted_at",
    "raw_delete_error",
    ".remove([",
    "completed_at",
    "input_size_bytes",
    "output_size_bytes",
    "error_message",
    "compressionRatio",
    "config.ffmpegPath",
    "config.rawBucket",
    "config.outputBucket",
    'import WebSocket from "ws"',
    "transport: WebSocket",
  ]) {
    if (!workerSource.includes(marker)) {
      throw new Error(`video worker source is missing ${marker}`);
    }
  }

  // The claim must happen before processing so two workers never run the same job.
  const indexSource = await readFile(path.join(workerDir, "src", "index.ts"), "utf8");
  const claimIndex = indexSource.indexOf("claimNextJob");
  const processIndex = indexSource.indexOf("processJob");
  if (claimIndex === -1 || processIndex === -1 || claimIndex > processIndex) {
    throw new Error("video worker loop must claim a queued job before processing it");
  }

  const dockerfile = await readFile(path.join(workerDir, "Dockerfile"), "utf8");
  if (!dockerfile.includes("ffmpeg")) {
    throw new Error("video worker Dockerfile must install ffmpeg");
  }

  // Functional check of the ffmpeg argument builders.
  const ffmpegModule = (await import(pathToFileURL(path.join(workerDir, "src", "ffmpeg.ts")).href)) as {
    buildTranscodeArgs(input: string, output: string, options: { crf: number; preset: string; maxWidth: number; maxHeight: number; fps: number }): string[];
    buildThumbnailArgs(input: string, output: string): string[];
  };
  const transcodeArgs = ffmpegModule.buildTranscodeArgs("input.mov", "optimized.mp4", {
    crf: 23,
    preset: "medium",
    maxWidth: 1080,
    maxHeight: 1920,
    fps: 30,
  });
  const joinedArgs = transcodeArgs.join(" ");
  for (const flag of ["libx264", "aac", "+faststart", "min(1080,iw)", ":-2", "fps=30", "-map_metadata"]) {
    if (!joinedArgs.includes(flag)) {
      throw new Error(`video worker transcode args must include ${flag}`);
    }
  }
  if (joinedArgs.includes("force_original_aspect_ratio") || joinedArgs.includes("trunc(iw/2)")) {
    throw new Error("video worker transcode filter must be the scale=min(width,iw):-2 form (no crop/force filters)");
  }
  if (!transcodeArgs.includes("23") || !transcodeArgs.includes("medium") || !transcodeArgs.includes("optimized.mp4")) {
    throw new Error("video worker transcode args must apply CRF, preset, and the output path");
  }
  const thumbnailArgs = ffmpegModule.buildThumbnailArgs("optimized.mp4", "thumbnail.jpg");
  const joinedThumbnail = thumbnailArgs.join(" ");
  if (!joinedThumbnail.includes("-ss 1") || !joinedThumbnail.includes("-frames:v 1") || !thumbnailArgs.includes("thumbnail.jpg")) {
    throw new Error("video worker thumbnail args must capture one frame at ~1 second");
  }

  console.log("Video worker package checks: ok");
}

async function checkContentStudioPhaseOne() {
  // Deterministic demo generation must work without OPENAI_API_KEY and stay compliance-safe.
  const coreUrl = pathToFileURL(path.join(repoRoot, "lib", "content-studio", "core.ts")).href;
  const core = (await import(coreUrl)) as {
    demoContentPackage(input?: Record<string, unknown>): Record<string, unknown>;
  };
  const demo = core.demoContentPackage({ service: "Чистка лица", city: "Астана", offer: "Бесплатная консультация", goal: "leads" });
  const requiredFields = [
    "ideaTitle",
    "hook",
    "script",
    "shotList",
    "textOnScreen",
    "voiceover",
    "caption",
    "adPrimaryText",
    "adHeadline",
    "cta",
    "photoPrompt",
    "videoPrompt",
    "whatsappMessage",
    "complianceNotes",
  ];
  for (const field of requiredFields) {
    const value = demo[field];
    const empty = Array.isArray(value) ? value.length === 0 : !(typeof value === "string" && value.trim());
    if (empty) {
      throw new Error(`demo content package must include ${field}`);
    }
  }
  // Public-facing texts must never guarantee results (complianceNotes describe the rules and are exempt).
  for (const field of ["adPrimaryText", "adHeadline", "caption", "script", "voiceover", "hook"]) {
    const text = String(demo[field] || "").toLowerCase();
    if (text.includes("100%") || text.includes("гарантиру") || text.includes("гарантия результата")) {
      throw new Error(`demo content package field ${field} must not guarantee results`);
    }
  }

  // Content Studio Phase 1 UI markers.
  const studio = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "ContentStudio.tsx"), "utf8");
  for (const marker of [
    "AI Контент-студия",
    "Из идеи",
    "Из материалов клиники",
    "Для рекламы",
    "Для соцсетей",
    "Reels 9:16",
    "TikTok 9:16",
    "Stories 9:16",
    "Feed 1:1",
    "Universal",
    "экспертно",
    "премиально",
    "generate-package",
    "Сгенерировать пакет",
    "Использовать в AI запуске рекламы",
    'source: "content_studio"',
    "generatedAt",
    "contentPackageId",
    "Демо-режим: подключите AI provider для настоящей генерации.",
    "checkMetaCompliance",
    "Проверка безопасных формулировок",
    "Photo prompt",
    "Video prompt",
    "WhatsApp сообщение",
    "Текст объявления Meta",
  ]) {
    if (!studio.includes(marker)) {
      throw new Error(`Content Studio Phase 1 is missing "${marker}"`);
    }
  }

  // Ads Automation must consume the studio prefill exactly once, without arming a launch.
  const adsAutomation = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"), "utf8");
  for (const marker of [
    'const STUDIO_PREFILL_KEY = "negis_ads_automation_prefill"',
    "window.localStorage.removeItem(STUDIO_PREFILL_KEY)",
    "Данные перенесены из AI Контент-студии. Проверьте параметры перед запуском.",
    'setActiveConfirmation("");',
  ]) {
    if (!adsAutomation.includes(marker)) {
      throw new Error(`Ads Automation studio prefill import is missing ${marker}`);
    }
  }

  console.log("Content Studio Phase 1 checks: ok");
}

async function checkPhotoCreativeBuilder() {
  const studio = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "ContentStudio.tsx"), "utf8");
  for (const marker of [
    "Фото-креатив",
    'accept="image/*"',
    "Загрузить фото",
    "Фото врача",
    "Кабинет клиники",
    "Процедура",
    "Общее фото клиники",
    "Reels/Stories 9:16",
    "Feed 1:1",
    "Universal 4:5",
    "Заголовок сверху + CTA снизу",
    "Тёмный градиент снизу",
    "Чистая медицинская карточка",
    "Минимальный премиум",
    "renderPhotoCreative",
    "canvas.toBlob",
    "Сгенерировать макет",
    "Скачать изображение",
    "Копировать текст",
    "Создать другую версию",
    "Использовать в AI запуске рекламы",
    "До: исходное фото",
    "После: готовый креатив",
    "Рискованные формулировки",
    'source: "content_studio_photo"',
    "uploadToSignedUrl",
    "Дисклеймер",
  ]) {
    if (!studio.includes(marker)) {
      throw new Error(`Photo creative builder is missing "${marker}"`);
    }
  }

  // Ads Automation must restore the studio image creative from the prefill.
  const adsAutomation = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"), "utf8");
  for (const marker of ["firstString(data.creativeUrl", 'fileType: "image"']) {
    if (!adsAutomation.includes(marker)) {
      throw new Error(`Ads Automation prefill must restore image creatives (${marker})`);
    }
  }

  console.log("Photo creative builder checks: ok");
}

async function checkLeadsPageSource() {
  const source = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "LeadsPage.tsx"), "utf8");
  for (const marker of [
    // Header + data source
    "Заявки",
    "Новые обращения из рекламы, сайта, WhatsApp и других источников.",
    "Добавить заявку",
    '"/api/crm/leads"',
    "useDemoCollection",
    // Summary metrics (real counts from loaded leads)
    "Всего заявок",
    "Новые",
    "В работе",
    "Записаны",
    "Потеряны",
    // CRM6 structured pipeline with legacy fallback
    '"/api/crm/lead-stages"',
    '"/api/crm/lead-sources"',
    "semanticGroupForLead",
    "structuredStagesAvailable",
    "structuredSourcesAvailable",
    'data-testid="lead-stage-select"',
    'data-testid="lead-source-select"',
    'data-testid="lead-source-input"',
    "Новая",
    "Записана",
    "Потеряна",
    // Search + filters container
    "Поиск: имя, телефон, источник или кампания",
    // Empty state
    "Заявок пока нет",
    "Когда клиника начнёт получать обращения из рекламы, сайта или WhatsApp, они появятся здесь.",
    // Lead actions (WhatsApp/call are phone-safe)
    "toWhatsappHref",
    "toTelHref",
    "saveAppointmentPrefill",
    "Подробнее",
    // Detail drawer + AI placeholder
    "AI-рекомендация появится после подключения CRM-аналитики.",
    // Add/edit form fields
    "Новая заявка",
    // Admin-only technical details (client mode hides them)
    "isAdminMode ? (",
    "client_id present:",
    "responsible_user_id present:",
    "stage_id present:",
    "source_id present:",
    "meta_campaign_launch_id present:",
    // CRM4: lead → client conversion + appointment prefill
    "Создать клиента",
    "Клиент уже создан",
    "Открыть клиентов",
    "convertLeadToClient",
    "loadExistingClients",
    "Клиент создан из заявки.",
    "Заявка связана с существующим клиентом.",
    "Данные переданы в запись.",
    "У заявки нет телефона. Проверьте данные клиента.",
    "Сначала создайте клиента, чтобы связать запись с карточкой пациента.",
    "Не удалось создать клиента.",
    "Не удалось связать заявку с клиентом.",
    "Не удалось подготовить запись.",
    // Relation is stored through the real client_id field, prefill carries it too.
    "clientId: savedClient.id",
    'clientId: lead.clientId || ""',
    "matched existing client:",
    // CRM7 — campaign attribution UI (existing meta-launches endpoint only)
    "/api/crm/meta-launches",
    "loadCampaignLaunchOptions",
    "campaignLaunchOptionFromRecord",
    "Рекламная кампания",
    "Не выбрана",
    "Кампания / услуга",
    "Кампания не связана",
    "создана выключенной",
    'data-testid="lead-campaign-select"',
    "linkedCampaignLabel",
    // Dry-run/test and failed launches are never offered as attribution targets.
    "isDryRunLaunchId",
    'status === "failed"',
    // Linked launch persists via metaCampaignLaunchId (uuid or explicit unlink).
    "metaCampaignLaunchId: form.metaCampaignLaunchId",
    // CRM8 — attribution metrics foundation (counts + secondary filter only)
    "attributionFilter",
    "attributionCounts",
    "С рекламой",
    "Без рекламы",
    "Связаны с рекламой",
    "Без рекламной кампании",
    'attributionFilter === "with_ads" && !lead.metaCampaignLaunchId',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`Leads page is missing "${marker}"`);
    }
  }
  // CRM8 counts leads only. Guard against actual metric implementations while
  // allowing comments that explicitly document their absence.
  for (const forbidden of [
    "costPerLead",
    "cost_per_lead",
    "attributedRevenue",
    "returnOnInvestment",
    "return_on_investment",
    'label: "CPL"',
    'label: "ROI"',
    'label: "ROMI"',
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(`Leads page must not implement attribution metric "${forbidden}"`);
    }
  }

  // Server mapping: PATCH lead.client_id must persist (uuid-guarded).
  const crmServer = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  if (!crmServer.includes("row.client_id = isUuid(clientId) ? clientId : null;")) {
    throw new Error("leads PATCH mapping must persist client_id (uuid-guarded)");
  }
  for (const marker of [
    'table: "lead_stages"',
    'table: "lead_sources"',
    "buildLeadReferenceRow",
    "does not belong to this workspace",
    "row.status = firstString(stage.stage_key, stage.name)",
    "row.source = readString(source.name)",
  ]) {
    if (!crmServer.includes(marker)) {
      throw new Error(`CRM6 server mapping is missing "${marker}"`);
    }
  }
  // Client-safe: no secrets, no raw storage internals in the leads screen.
  for (const forbidden of ["SERVICE_ROLE", "service_role", "ad-creatives-raw"]) {
    if (source.includes(forbidden)) {
      throw new Error(`Leads page must not reference "${forbidden}"`);
    }
  }

  // Route wiring: /leads uses the real LeadsPage, not the demo module.
  const app = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "App.tsx"), "utf8");
  if (!app.includes('import LeadsPage from "@/pages/LeadsPage"')) {
    throw new Error("App must import the real LeadsPage");
  }
  if (!app.includes("<ProtectedPage component={LeadsPage} permission=\"crm\" />")) {
    throw new Error("App must route /leads to LeadsPage");
  }
  if (app.includes("component={DemoLeads}")) {
    throw new Error("App must no longer route /leads to DemoLeads");
  }

  console.log("Leads page checks: ok");
}

async function checkClientsPageSource() {
  const source = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "ClientsPage.tsx"), "utf8");
  for (const marker of [
    // Header + data source
    "Клиенты",
    "База пациентов, история обращений, записей и повторных визитов.",
    "Добавить клиента",
    '"/api/crm/clients"',
    "useDemoCollection",
    // Related history uses the existing sibling endpoints (client_id or phone match)
    '"/api/crm/leads"',
    '"/api/crm/appointments"',
    '"/api/crm/calls"',
    "matchesClient",
    // Summary metrics (real counts from loaded clients)
    "Всего клиентов",
    "Новые",
    "Активные",
    "Нужен повторный визит",
    "Без последнего визита",
    // Filters
    "Повторный визит",
    "Без визита",
    // Status mapping (visual normalization only, no new status table)
    "normalizeClientStatus",
    "Новый",
    "Активный",
    "Неактивный",
    // Search
    "Поиск: имя, телефон, WhatsApp, источник или заметка",
    // Empty state
    "Клиентов пока нет",
    "Когда клиника начнёт получать заявки и создавать записи, пациенты появятся здесь.",
    // Client actions (WhatsApp/call are phone-safe, Записать reuses the appointment prefill)
    "toWhatsappHref",
    "toTelHref",
    "saveAppointmentPrefill",
    "Подробнее",
    // Detail drawer: related history + honest empty state + AI placeholder
    "Заявки этого клиента",
    "Записи этого клиента",
    "Звонки этого клиента",
    "История появится после новых заявок, записей и звонков.",
    "AI-рекомендация по клиенту появится после подключения CRM-аналитики.",
    // Add/edit form
    "Новый клиент",
    "Изменить клиента",
    // Admin-only technical details (client mode hides them)
    "isAdminMode ? (",
    "client id:",
    "related leads:",
    "related appointments:",
    "related calls:",
    "Данные ограничены текущей клиникой (workspace).",
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`Clients page is missing "${marker}"`);
    }
  }
  // Client-safe: no secrets, no raw storage internals in the clients screen.
  for (const forbidden of ["SERVICE_ROLE", "service_role", "ad-creatives-raw"]) {
    if (source.includes(forbidden)) {
      throw new Error(`Clients page must not reference "${forbidden}"`);
    }
  }

  // Route wiring: /clients uses the real ClientsPage, not the demo module.
  const app = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "App.tsx"), "utf8");
  if (!app.includes('import ClientsPage from "@/pages/ClientsPage"')) {
    throw new Error("App must import the real ClientsPage");
  }
  if (!app.includes('path="/clients" component={() => <ProtectedPage component={ClientsPage}')) {
    throw new Error("App must route /clients to ClientsPage");
  }
  if (app.includes('path="/clients" component={() => <ProtectedPage component={DemoClients}')) {
    throw new Error("App must no longer route /clients to DemoClients");
  }

  console.log("Clients page checks: ok");
}

// CRM9c — real Sales UI over the existing workspace-scoped deals resource.
async function checkSalesPageSource() {
  const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");
  const source = await readFile(path.join(negisSrc, "pages", "SalesPage.tsx"), "utf8");
  for (const marker of [
    "Negis OS · CRM",
    "Продажи",
    "Оплаты, услуги и выручка клиники.",
    "Добавить продажу",
    "Продаж пока нет",
    "Сумма оплаченных",
    "Ожидает оплаты",
    "Оплачена",
    "Отменена",
    "Возврат",
    'useDemoCollection<Deal>("negis_demo_deals", dealsSeed',
    'endpoint: "/api/crm/deals"',
    'listKey: "deals"',
    "tengeToAmountMinor",
    "amountMinorToTengeInput",
    'const paid = items.filter((deal) => deal.status === "paid");',
    "paid.reduce((sum, deal) => sum + deal.amountMinor, 0)",
    "loadReferenceCollection",
    "negis_deal_prefill",
    "handleLeadSelection",
    "current.clientId || lead?.clientId",
    "current.metaCampaignLaunchId || lead?.metaCampaignLaunchId",
    'data-testid="deal-client-select"',
    'data-testid="deal-lead-select"',
    'data-testid="deal-appointment-select"',
    'data-testid="deal-campaign-select"',
    "Загружаем данные…",
    "!loaded ? (",
    "if (isRealWorkspace()) return [];",
    "Технические данные продажи",
    "deal id present:",
    "client_id present:",
    "lead_id present:",
    "appointment_id present:",
    "meta_campaign_launch_id present:",
    "responsible_user_id present:",
    // CRM10 — honest revenue attribution (manual campaign links, paid deals only)
    "attributionFilter",
    "С рекламой",
    "Без рекламы",
    "Оплачено с рекламой",
    "Оплачено без рекламы",
    "Выручка по связанным кампаниям",
    "Без учёта расходов на рекламу.",
    'attributionFilter === "with_ads" && !deal.metaCampaignLaunchId',
    "campaignRevenueRows",
    'deal.status !== "paid" || !deal.metaCampaignLaunchId',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`Sales page is missing "${marker}"`);
    }
  }

  // Client mode never renders raw linked IDs. Admin details expose presence only.
  for (const forbidden of [
    "publicUrl",
    "raw_payload",
    "META_ACCESS_TOKEN",
    "accessToken",
    "deal id: {deal.id}",
    "client_id: {deal.clientId}",
    "lead_id: {deal.leadId}",
    "appointment_id: {deal.appointmentId}",
    "meta_campaign_launch_id: {deal.metaCampaignLaunchId}",
    "responsible_user_id: {deal.responsibleUserId}",
    "costPerLead",
    "cost_per_lead",
    "returnOnInvestment",
    "return_on_investment",
    "revenueByCampaign",
    "roiValue",
    "romiValue",
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(`Sales page must not expose or calculate "${forbidden}"`);
    }
  }

  const app = await readFile(path.join(negisSrc, "App.tsx"), "utf8");
  if (!app.includes('import SalesPage from "@/pages/SalesPage"')) {
    throw new Error("App must import the real SalesPage");
  }
  if (!app.includes('path="/sales" component={() => <ProtectedPage component={SalesPage} permission="crm" />}')) {
    throw new Error("App must route /sales to SalesPage");
  }
  if (app.includes('path="/sales" component={() => <ProtectedPage component={DemoClients}')) {
    throw new Error("App must no longer route /sales to DemoClients");
  }

  const sidebar = await readFile(path.join(negisSrc, "components", "layout", "Sidebar.tsx"), "utf8");
  const topNav = await readFile(path.join(negisSrc, "components", "layout", "TopNav.tsx"), "utf8");
  const mobileNav = await readFile(path.join(negisSrc, "components", "layout", "MobileNav.tsx"), "utf8");
  const topbar = await readFile(path.join(negisSrc, "components", "layout", "Topbar.tsx"), "utf8");
  for (const [name, navSource] of [["Sidebar", sidebar], ["TopNav", topNav], ["MobileNav", mobileNav], ["Topbar", topbar]] as const) {
    if (!navSource.includes("/sales") || !navSource.includes("Продажи")) {
      throw new Error(`${name} must expose the Sales page with a friendly label`);
    }
  }

  const leads = await readFile(path.join(negisSrc, "pages", "LeadsPage.tsx"), "utf8");
  const clients = await readFile(path.join(negisSrc, "pages", "ClientsPage.tsx"), "utf8");
  for (const [name, pageSource] of [["LeadsPage", leads], ["ClientsPage", clients]] as const) {
    if (!pageSource.includes("negis_deal_prefill") || !pageSource.includes("Оформить продажу") || !pageSource.includes('href="/sales"')) {
      throw new Error(`${name} must provide the Sales prefill entry point`);
    }
  }

  console.log("Sales page checks: ok");
}

// CRM6.1 — production (UUID workspace) must never render or persist demo data.
async function checkCrmProductionGuards() {
  const negisSrc = path.join(repoRoot, "artifacts", "negis", "src");
  const storage = await readFile(path.join(negisSrc, "lib", "demoStorage.ts"), "utf8");
  for (const marker of [
    // Workspace detection shared with pages (same discriminator as the server).
    "export function readWorkspaceId",
    "export function isRealWorkspace",
    // Production collections start empty and never show seeds before the API answers.
    "const [productionMode] = useState(() => Boolean(endpoint) && isRealWorkspace());",
    "useState<TItem[]>(() => (productionMode ? [] : seed))",
    "const [loaded, setLoaded] = useState(() => !productionMode);",
    // Production skips the demo localStorage hydrate/write entirely.
    "if (productionMode) return;",
    // Supabase data is never cached into negis_demo_* keys.
    "if (!productionMode) writeDemoStorage(key, mapped);",
    "if (!productionMode) writeDemoStorage(key, value);",
    // loaded settles after the first API response (success or failure).
    "setLoaded(true)",
    // Demo mode keeps the original seed + localStorage fallback.
    "const nextItems = Array.isArray(saved) && saved.length > 0 ? saved : seed;",
  ]) {
    if (!storage.includes(marker)) {
      throw new Error(`demoStorage production guard is missing "${marker}"`);
    }
  }

  const leads = await readFile(path.join(negisSrc, "pages", "LeadsPage.tsx"), "utf8");
  for (const marker of [
    "Загружаем данные…",
    "!loaded ? (",
    // Production duplicate check never uses demo clients.
    "if (isRealWorkspace()) return [];",
    // Production conversion never writes into negis_demo_clients.
    "if (!isRealWorkspace()) {",
  ]) {
    if (!leads.includes(marker)) {
      throw new Error(`LeadsPage production guard is missing "${marker}"`);
    }
  }

  const clients = await readFile(path.join(negisSrc, "pages", "ClientsPage.tsx"), "utf8");
  for (const marker of ["Загружаем данные…", "!loaded ? (", "if (isRealWorkspace()) return [];"]) {
    if (!clients.includes(marker)) {
      throw new Error(`ClientsPage production guard is missing "${marker}"`);
    }
  }

  const sales = await readFile(path.join(negisSrc, "pages", "SalesPage.tsx"), "utf8");
  for (const marker of ["Загружаем данные…", "!loaded ? (", "if (isRealWorkspace()) return [];", 'useDemoCollection<Deal>("negis_demo_deals", dealsSeed']) {
    if (!sales.includes(marker)) {
      throw new Error(`SalesPage production guard is missing "${marker}"`);
    }
  }

  const controlCenter = await readFile(path.join(negisSrc, "pages", "AiControlCenter.tsx"), "utf8");
  if (!controlCenter.includes("if (isRealWorkspace()) return { responded: false, items: [] };")) {
    throw new Error("AiControlCenter must not count demo CRM data for a UUID workspace");
  }

  console.log("CRM production guard checks: ok");
}

// CRM9a+b — deals foundation: migration 020 + generic CRM API resource.
async function checkCrmDealsFoundation() {
  const migration = await readFile(path.join(repoRoot, "migrations", "020_crm_deals_foundation.sql"), "utf8");
  for (const marker of [
    "create table if not exists public.deals",
    "workspace_id uuid not null references public.workspaces(id) on delete cascade",
    "client_id uuid references public.clients(id) on delete set null",
    "lead_id uuid references public.leads(id) on delete set null",
    "appointment_id uuid references public.appointments(id) on delete set null",
    "meta_campaign_launch_id uuid references public.meta_campaign_launches(id) on delete set null",
    "responsible_user_id uuid references public.staff_users(id) on delete set null",
    "amount_minor bigint not null default 0 check (amount_minor >= 0)",
    "status in ('pending', 'paid', 'cancelled', 'refunded')",
    "currency text not null default 'KZT'",
    "deals_workspace_status_idx",
    "deals_workspace_paid_at_idx",
    "deals_workspace_created_at_idx",
    "deals_workspace_meta_campaign_launch_idx",
  ]) {
    if (!migration.includes(marker)) {
      throw new Error(`migration 020 is missing ${marker}`);
    }
  }

  const server = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  for (const marker of [
    '| "deals"',
    "makeDeal",
    "DEAL_STATUSES",
    "dealStatusTimestamps",
    // Same-workspace reference validation (CRM6 pattern) for every deal link.
    "buildDealReferenceRow",
    'table: "clients", fieldName: "clientId"',
    'table: "staff_users", fieldName: "responsibleUserId"',
    // Status timestamps: paid stamps paid_at; terminal statuses stamp closed_at.
    'status === "paid" && !hasAnyKey(body, ["paidAt", "paid_at"])',
    'status !== "pending" && !hasAnyKey(body, ["closedAt", "closed_at"])',
  ]) {
    if (!server.includes(marker)) {
      throw new Error(`CRM server deals mapping is missing ${marker}`);
    }
  }
  // Deals foundation counts money honestly — no ad-efficiency math in the CRM server.
  for (const forbidden of ["CPL", "ROI", "ROMI"]) {
    if (server.includes(forbidden)) {
      throw new Error(`CRM server must not calculate "${forbidden}"`);
    }
  }

  const catchAll = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  if (!catchAll.includes('"deals"')) {
    throw new Error("api/crm catch-all must register the deals resource");
  }

  const doc = await readFile(path.join(repoRoot, "docs", "CRM-DEALS.md"), "utf8");
  for (const marker of [
    "Продажи",
    "Ожидает оплаты",
    "Оплачена",
    "Отменена",
    "Возврат",
    "amount_minor",
    "paid_at",
    "readWorkspaceReference",
    "Future scope",
    "CRM9c",
    "UI ₸ → API `amountMinor`",
    "negis_deal_prefill",
    "negis_demo_deals",
    "CRM9d",
    "paidAt",
    "Подтвердите оплату продаж",
    "Не удалось проверить",
    // CRM10 — attribution is documented as manual counting, never effectiveness.
    "CRM10",
    "Оплачено с рекламой",
    "Выручка по связанным кампаниям",
    "Без учёта расходов на рекламу.",
    "Свяжите продажи с рекламными кампаниями",
    "не ROI",
  ]) {
    if (!doc.includes(marker)) {
      throw new Error(`CRM deals documentation is missing ${marker}`);
    }
  }

  // Functional demo-mode checks against the running dev server.
  const created = await checkJsonEndpoint("/api/crm/deals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId: "demo-workspace", title: "Чистка лица", amountMinor: 2500000, status: "paid" }),
  });
  const createdItem = (created.data && typeof created.data === "object" ? (created.data as { item?: Record<string, unknown> }).item : undefined) || {};
  if (createdItem.status !== "paid" || !createdItem.paidAt || !createdItem.closedAt) {
    throw new Error("POST /api/crm/deals with status paid must stamp paidAt and closedAt");
  }
  if (createdItem.amountMinor !== 2500000 || createdItem.currency !== "KZT") {
    throw new Error("POST /api/crm/deals must keep amountMinor and default currency KZT");
  }

  const patched = await checkJsonEndpoint("/api/crm/deals", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "deal-smoke-1", workspaceId: "demo-workspace", updates: { title: "Чистка лица", status: "paid" } }),
  });
  const patchedItem = (patched.data && typeof patched.data === "object" ? (patched.data as { item?: Record<string, unknown> }).item : undefined) || {};
  if (patchedItem.status !== "paid" || !patchedItem.paidAt) {
    throw new Error("PATCH /api/crm/deals status paid must stamp paidAt");
  }

  await checkJsonFailure(
    "/api/crm/deals",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "demo-workspace", amountMinor: 1000 }),
    },
    "title is required",
  );
  await checkJsonFailure(
    "/api/crm/deals",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "demo-workspace", title: "Тест", status: "archived" }),
    },
    "status must be one of",
  );
  await checkJsonFailure(
    "/api/crm/deals",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "demo-workspace", title: "Тест", amountMinor: -5 }),
    },
    "amountMinor must be >= 0",
  );

  console.log("CRM deals foundation checks: ok");
}

// CRM11a — schema-only foundation for normalized daily Meta Insights.
async function checkMetaInsightsSchemaFoundation() {
  const migration = await readFile(path.join(repoRoot, "migrations", "021_meta_campaign_insights_foundation.sql"), "utf8");
  for (const marker of [
    "create table if not exists public.meta_campaign_insights",
    "workspace_id uuid not null references public.workspaces(id) on delete cascade",
    "meta_campaign_launch_id uuid not null references public.meta_campaign_launches(id) on delete cascade",
    "meta_campaign_id text not null",
    "date_start date not null",
    "date_stop date not null",
    "spend_minor bigint not null default 0 check (spend_minor >= 0)",
    "currency_exponent integer not null default 2 check (currency_exponent >= 0 and currency_exponent <= 6)",
    "action_counts jsonb not null default '{}'::jsonb",
    "fetched_at timestamptz not null default now()",
    "unique (workspace_id, meta_campaign_launch_id, date_start, date_stop)",
    "check (date_stop >= date_start)",
    "meta_campaign_insights_workspace_launch_date_idx",
    "meta_campaign_insights_workspace_date_idx",
    "meta_campaign_insights_workspace_campaign_date_idx",
    "meta_campaign_insights_workspace_fetched_at_idx",
    "create table if not exists public.meta_insights_sync_runs",
    "status in ('pending', 'running', 'succeeded', 'failed')",
    "rows_upserted integer not null default 0 check (rows_upserted >= 0)",
    "error_code text",
    "error_message text",
    "meta_insights_sync_runs_workspace_created_at_idx",
    "meta_insights_sync_runs_workspace_status_created_at_idx",
    "meta_insights_sync_runs_workspace_launch_created_at_idx",
  ]) {
    if (!migration.includes(marker)) {
      throw new Error(`migration 021 is missing ${marker}`);
    }
  }

  for (const forbidden of ["raw_meta_response", "raw_response jsonb", "paging_url", "access_token", "app_secret"]) {
    if (migration.toLowerCase().includes(forbidden)) {
      throw new Error(`migration 021 must not store ${forbidden}`);
    }
  }

  const doc = await readFile(path.join(repoRoot, "docs", "META-INSIGHTS-FOUNDATION.md"), "utf8");
  for (const marker of [
    "плановый бюджет, а не фактический расход",
    "`time_increment=1`",
    "`reach` неаддитивен",
    "`meta_leads` не является количеством заявок CRM",
    "Сырые ответы Meta не сохраняются",
    "Paging URL не сохраняются",
    "фактический расход по кампании",
    "оплаченную выручку, вручную связанную с кампанией",
    "оплаченную выручку без рекламной атрибуции",
    "## Что пока не рассчитывается",
    "CPL",
    "ROI",
    "ROMI",
    "автоматические рекомендации по бюджету",
    "server-only helper",
    "ручную admin-синхронизацию",
    "фоновую синхронизацию",
  ]) {
    if (!doc.includes(marker)) {
      throw new Error(`Meta Insights foundation documentation is missing ${marker}`);
    }
  }

  console.log("Meta Insights schema foundation checks: ok");
}

async function checkCrmServerAuthFoundation() {
  const authHelper = await readFile(path.join(repoRoot, "lib", "auth", "server.ts"), "utf8");
  for (const marker of [
    "requireWorkspaceAdmin",
    "req.headers.authorization",
    "Bearer",
    "/auth/v1/user",
    "Authorization: `Bearer ${token}`",
    "apikey: serviceRoleKey",
    '.from("staff_users")',
    '.eq("auth_user_id", userId)',
    '.eq("workspace_id", workspaceId)',
    '.eq("status", "active")',
    'new Set(["owner", "admin"])',
    "WorkspaceAdminAuthError(401",
    "WorkspaceAdminAuthError(403",
  ]) {
    if (!authHelper.includes(marker)) {
      throw new Error(`CRM server auth helper is missing ${marker}`);
    }
  }
  for (const forbidden of [
    "localStorage",
    "access_token:",
    "mode: \"demo\"",
    "supabase.auth.getUser(",
    "admin.getUserById",
  ]) {
    if (authHelper.includes(forbidden)) {
      throw new Error(`CRM server auth helper must not trust or expose ${forbidden}`);
    }
  }

  const crmServer = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  for (const marker of [
    "handleCrmAuthContext",
    "requireWorkspaceAdmin(req, workspaceId)",
    'success("supabase"',
    "staffUserId: context.staffUserId",
    "isAdmin: true",
  ]) {
    if (!crmServer.includes(marker)) {
      throw new Error(`CRM auth-context handler is missing ${marker}`);
    }
  }
  const authContextHandler = crmServer.slice(
    crmServer.indexOf("export async function handleCrmAuthContext"),
    crmServer.indexOf("export async function handleCrmResource"),
  );
  if (!authContextHandler || authContextHandler.includes('success("demo"')) {
    throw new Error("CRM auth-context endpoint must not have a demo fallback");
  }

  const apiSource = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  if (!apiSource.includes('resource === "auth-context"') || !apiSource.includes("handleCrmAuthContext(req, res)")) {
    throw new Error("api/crm catch-all must route /api/crm/auth-context");
  }
  const frontendHelper = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "lib", "serverAuth.ts"), "utf8");
  for (const marker of ["supabase.auth.getSession()", "data.session?.access_token", "getSupabaseAccessToken"]) {
    if (!frontendHelper.includes(marker)) {
      throw new Error(`Frontend server auth helper is missing ${marker}`);
    }
  }
  if (frontendHelper.includes("localStorage")) {
    throw new Error("Frontend Bearer helper must read the Supabase session, not localStorage role data");
  }

  const adminCenter = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"), "utf8");
  for (const marker of [
    "/api/crm/auth-context?workspaceId=",
    "getSupabaseAccessToken()",
    "Authorization: `Bearer ${accessToken}`",
    "Админ-доступ подтверждён",
    "Нужно войти заново",
    "Недостаточно прав",
  ]) {
    if (!adminCenter.includes(marker)) {
      throw new Error(`Admin Center server auth status is missing ${marker}`);
    }
  }

  const doc = await readFile(path.join(repoRoot, "docs", "CRM-SERVER-AUTH.md"), "utf8");
  for (const marker of [
    "localStorage",
    "Authorization: Bearer",
    "/auth/v1/user",
    "auth_user_id",
    "status = active",
    "owner",
    "admin",
    "Demo/localStorage-сессия не получает доступ",
    "ручная синхронизация Meta Insights",
    "POST /api/crm/meta-insights-sync",
    "GET /api/crm/meta-campaign-insights",
  ]) {
    if (!doc.includes(marker)) {
      throw new Error(`CRM server auth documentation is missing ${marker}`);
    }
  }

  console.log("CRM server admin auth foundation checks: ok");
}

async function checkMetaInsightsSyncFoundation() {
  const insightsPath = path.join(repoRoot, "lib", "meta", "insights.ts");
  const insightsSource = await readFile(insightsPath, "utf8");
  for (const marker of [
    "fetchCampaignInsightsDaily",
    "normalizeInsightRow",
    "decimalToMinor",
    "normalizeActionCounts",
    "/insights?",
    "date_start",
    "date_stop",
    "campaign_id",
    "account_currency",
    "spend",
    "impressions",
    "reach",
    "clicks",
    "inline_link_clicks",
    "actions",
    'time_increment: "1"',
    'action_report_time: "conversion"',
    'limit: "100"',
    "cursors",
    'query.set("after", after)',
    "seenCursors",
    "pageLimit ?? 10",
    "BigInt(combined)",
    'action_type) !== "lead"',
    "Authorization: `Bearer ${config.accessToken}`",
  ]) {
    if (!insightsSource.includes(marker)) {
      throw new Error(`Meta Insights helper is missing ${marker}`);
    }
  }
  for (const forbidden of ["paging.next", 'paging["next"]', "console.log", "console.warn", "parseFloat(", "access_token="]) {
    if (insightsSource.includes(forbidden)) {
      throw new Error(`Meta Insights helper must not use or expose ${forbidden}`);
    }
  }
  const moneyFunction = insightsSource.slice(
    insightsSource.indexOf("export function decimalToMinor"),
    insightsSource.indexOf("export function normalizeActionCounts"),
  );
  if (!moneyFunction.includes("BigInt") || moneyFunction.includes("parseFloat") || moneyFunction.includes("Number(value)")) {
    throw new Error("Meta spend normalization must use integer-safe decimal parsing without floating point money");
  }

  const insightsModule = (await import(`${pathToFileURL(insightsPath).href}?crm11b=${Date.now()}`)) as {
    decimalToMinor(spend: string, exponent: number): string;
    normalizeActionCounts(actions: unknown): Record<string, string>;
    normalizeInsightRow(
      value: unknown,
      context: {
        workspaceId: string;
        metaCampaignLaunchId: string;
        metaCampaignId: string;
        expectedCurrency: string;
        apiVersion: string;
      },
    ): { spendMinor: string; metaLeads: string | null; actionCounts: Record<string, string> };
  };
  if (
    insightsModule.decimalToMinor("12.34", 2) !== "1234" ||
    insightsModule.decimalToMinor("0.01", 2) !== "1" ||
    insightsModule.decimalToMinor("7", 2) !== "700"
  ) {
    throw new Error("decimalToMinor produced an incorrect minor-unit value");
  }
  let excessPrecisionRejected = false;
  try {
    insightsModule.decimalToMinor("1.001", 2);
  } catch {
    excessPrecisionRejected = true;
  }
  if (!excessPrecisionRejected) {
    throw new Error("decimalToMinor must reject non-zero precision beyond the currency exponent");
  }
  const actionCounts = insightsModule.normalizeActionCounts([
    { action_type: "lead", value: "2" },
    { action_type: "purchase", value: "99" },
    { action_type: "lead", value: "3" },
  ]);
  if (actionCounts.lead !== "5" || Object.keys(actionCounts).length !== 1) {
    throw new Error("Meta action normalization must allowlist and aggregate only lead actions");
  }
  const normalized = insightsModule.normalizeInsightRow(
    {
      date_start: "2026-07-01",
      date_stop: "2026-07-01",
      campaign_id: "123456789",
      account_currency: "KZT",
      spend: "10.25",
      impressions: "20",
      reach: "15",
      clicks: "4",
      inline_link_clicks: "3",
      actions: [{ action_type: "lead", value: "1" }],
    },
    {
      workspaceId: "9eb6f100-bb6a-4f99-9719-e85c34513a03",
      metaCampaignLaunchId: "11111111-1111-4111-8111-111111111111",
      metaCampaignId: "123456789",
      expectedCurrency: "KZT",
      apiVersion: "v23.0",
    },
  );
  if (normalized.spendMinor !== "1025" || normalized.metaLeads !== "1" || normalized.actionCounts.lead !== "1") {
    throw new Error("Meta daily insight normalization produced incorrect safe values");
  }

  const crmServer = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  for (const marker of [
    "handleMetaInsightsSync",
    "handleMetaCampaignInsights",
    "handleMetaInsightsSyncRuns",
    "loadMetaInsightsLaunchContext",
    "requireWorkspaceAdmin(req, workspaceId)",
    '.from("meta_insights_sync_runs")',
    '.from("meta_campaign_insights")',
    'status: "pending"',
    'status: "running"',
    'status: "succeeded"',
    'status: "failed"',
    'onConflict: "workspace_id,meta_campaign_launch_id,date_start,date_stop"',
    "fetched.rows.length === 0",
    "META_INSIGHTS_MAX_RANGE_DAYS = 31",
  ]) {
    if (!crmServer.includes(marker)) {
      throw new Error(`CRM Meta Insights handlers are missing ${marker}`);
    }
  }
  for (const code of [
    "meta_auth",
    "meta_permission",
    "meta_rate_limited",
    "invalid_range",
    "launch_not_eligible",
    "normalization_failed",
    "persistence_failed",
    "sync_timeout",
  ]) {
    if (!insightsSource.includes(`"${code}"`)) {
      throw new Error(`Meta Insights safe error allowlist is missing ${code}`);
    }
  }

  const syncHandler = crmServer.slice(
    crmServer.indexOf("export async function handleMetaInsightsSync"),
    crmServer.indexOf("export async function handleMetaCampaignInsights"),
  );
  const readHandler = crmServer.slice(
    crmServer.indexOf("export async function handleMetaCampaignInsights"),
    crmServer.indexOf("export async function handleMetaInsightsSyncRuns"),
  );
  for (const [name, handler] of [["sync", syncHandler], ["read", readHandler]] as const) {
    if (!handler.includes("requireWorkspaceAdmin(req, workspaceId)")) {
      throw new Error(`Meta Insights ${name} endpoint must require server-verified workspace admin`);
    }
    if (handler.includes('success("demo"')) {
      throw new Error(`Meta Insights ${name} endpoint must not have a demo fallback`);
    }
  }

  const databaseMapper = crmServer.slice(
    crmServer.indexOf("function normalizedInsightToDatabaseRow"),
    crmServer.indexOf("function databaseIntegerString"),
  );
  for (const forbidden of ["raw_response", "rawMeta", "paging", "accessToken", "appSecret", "publicUrl"]) {
    if (databaseMapper.includes(forbidden)) {
      throw new Error(`Meta Insights persistence mapper must not store ${forbidden}`);
    }
  }

  const apiSource = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  for (const marker of [
    'resource === "meta-insights-sync"',
    "handleMetaInsightsSync(req, res)",
    'resource === "meta-campaign-insights"',
    "handleMetaCampaignInsights(req, res)",
    'resource === "meta-insights-sync-runs"',
    "handleMetaInsightsSyncRuns(req, res)",
  ]) {
    if (!apiSource.includes(marker)) {
      throw new Error(`CRM catch-all is missing ${marker}`);
    }
  }

  const adminCenter = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdminCenter.tsx"), "utf8");
  for (const marker of [
    "Meta Insights: ручная синхронизация",
    "Meta Insights · диагностика",
    "Синхронизировать Insights",
    "/api/crm/meta-insights-sync",
    "/api/crm/meta-insights-sync-runs",
    "/api/crm/meta-campaign-insights",
    "getSupabaseAccessToken()",
    "Authorization: `Bearer ${accessToken}`",
    "summarizeMetaInsightRows",
    "BigInt(row.spendMinor)",
    "Всего строк Insights",
    "Последние данные fetched_at",
    "Meta не вернула данные за выбранный период. Это нормально для выключенных или не откручивавшихся кампаний.",
    "Расходы Meta показываются отдельно от выручки CRM.",
    "Это ещё не ROI и не эффективность рекламы.",
    "Кампания и её статус не изменяются",
  ]) {
    if (!adminCenter.includes(marker)) {
      throw new Error(`Admin Center Meta Insights diagnostics are missing ${marker}`);
    }
  }
  const diagnosticsCardStart = adminCenter.indexOf('data-testid="meta-insights-diagnostics"');
  const diagnosticsCardEnd = adminCenter.indexOf(
    '<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">',
    diagnosticsCardStart,
  );
  if (diagnosticsCardStart < 0 || diagnosticsCardEnd < 0) {
    throw new Error("Admin Center Meta Insights diagnostics card boundaries are missing");
  }
  const diagnosticsCard = adminCenter.slice(diagnosticsCardStart, diagnosticsCardEnd);
  for (const forbidden of ["rawResponse", "raw_response", "paging.next", "pagingUrl", "accessToken", "appSecret"]) {
    if (diagnosticsCard.includes(forbidden)) {
      throw new Error(`Admin Center Meta Insights diagnostics must not expose ${forbidden}`);
    }
  }

  const doc = await readFile(path.join(repoRoot, "docs", "META-INSIGHTS-FOUNDATION.md"), "utf8");
  for (const marker of [
    "## CRM11b: ручная синхронизация",
    "server-only",
    "owner",
    "admin",
    "31 дня",
    "10 страниц",
    "cursors.after",
    "pending",
    "running",
    "succeeded",
    "failed",
    "Искусственные нулевые строки",
    "background sync",
    "## CRM11c: диагностика доступности Insights",
    "Meta Insights · диагностика",
    "succeeded` с `rows_upserted = 0",
    "планового бюджета кампании",
    "Расходы Meta также показываются отдельно от выручки CRM",
    "ещё не является ROI",
  ]) {
    if (!doc.toLowerCase().includes(marker.toLowerCase())) {
      throw new Error(`Meta Insights documentation is missing ${marker}`);
    }
  }

  for (const source of [insightsSource, crmServer, adminCenter]) {
    if (/\b(?:cpl|roi|romi)\s*[:=]/i.test(source)) {
      throw new Error("CRM11b must not add CPL, ROI or ROMI calculations");
    }
  }

  console.log("Meta Insights manual sync and diagnostics foundation checks: ok");
}

async function checkMetaInsightsHistoryFoundation() {
  const crmServer = await readFile(path.join(repoRoot, "lib", "crm", "server.ts"), "utf8");
  const apiSource = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  const adsHistory = await readFile(path.join(repoRoot, "artifacts", "negis", "src", "pages", "AdsAutomation.tsx"), "utf8");
  const doc = await readFile(path.join(repoRoot, "docs", "META-INSIGHTS-FOUNDATION.md"), "utf8");

  for (const marker of [
    'resource === "meta-insights-history"',
    "handleMetaInsightsHistory(req, res)",
  ]) {
    if (!apiSource.includes(marker)) throw new Error(`CRM catch-all is missing ${marker}`);
  }

  const helperStart = crmServer.indexOf('type MetaInsightsHistoryAvailability =');
  const helperEnd = crmServer.indexOf("function asSafeMetaInsightsError", helperStart);
  const handlerStart = crmServer.indexOf("export async function handleMetaInsightsHistory");
  const handlerEnd = crmServer.indexOf("export async function handleMetaInsightsSyncRuns", handlerStart);
  if (helperStart < 0 || helperEnd < 0 || handlerStart < 0 || handlerEnd < 0) {
    throw new Error("Meta Insights history helper or handler boundaries are missing");
  }
  const historyHelper = crmServer.slice(helperStart, helperEnd);
  const historyHandler = crmServer.slice(handlerStart, handlerEnd);

  for (const marker of [
    "META_INSIGHTS_HISTORY_LAUNCH_LIMIT = 40",
    "loadLatestMetaInsightsRunsByLaunch",
    '.eq("meta_campaign_launch_id", launchId)',
    ".limit(1)",
    'select("id", { count: "exact", head: true })',
    ".range(offset, pageStop)",
    "rows.length !== rowCount",
    "META_INSIGHTS_HISTORY_MAX_ROWS",
    "BigInt(",
    "currencyExponent",
    "currencyKey",
    '.from("meta_campaign_insights")',
    "meta_campaign_launch_id",
    '"available"',
    '"not_synced"',
    '"empty"',
    '"running"',
    '"failed"',
    '"unavailable"',
  ]) {
    if (!historyHelper.includes(marker)) throw new Error(`Meta Insights history aggregation is missing ${marker}`);
  }
  if (/\.limit\((?:20|500)\)/.test(historyHelper)) {
    throw new Error("Meta Insights history must not silently truncate runs or insight rows at 20/500");
  }
  if (/\breach\b/.test(historyHelper)) {
    throw new Error("Meta Insights history aggregate must deliberately omit non-additive daily reach");
  }
  for (const forbidden of ["raw_response", "paging.next", "pagingUrl", "accessToken", "appSecret", "action_counts"]) {
    if (historyHelper.includes(forbidden)) throw new Error(`Meta Insights history helper must not expose ${forbidden}`);
  }

  for (const marker of [
    "requireWorkspaceAdmin(req, workspaceId)",
    '.from("meta_campaign_launches")',
    "expectedCampaignByLaunch",
    "metaCampaignLaunchId: launchId",
    'success("supabase"',
  ]) {
    if (!historyHandler.includes(marker)) throw new Error(`Meta Insights history endpoint is missing ${marker}`);
  }
  if (historyHandler.includes('success("demo"')) {
    throw new Error("Meta Insights history endpoint must not have a demo fallback");
  }
  const summaryDto = historyHandler.slice(historyHandler.indexOf("const summaries"), historyHandler.indexOf("return sendJson"));
  for (const forbidden of ["reach", "rawResponse", "raw_response", "paging", "accessToken", "appSecret", "payload:", "metaCampaignId:"]) {
    if (summaryDto.includes(forbidden)) throw new Error(`Meta Insights history DTO must not expose ${forbidden}`);
  }

  const authEffectStart = adsHistory.indexOf("The local admin UI toggle is presentation only");
  const authEffectEnd = adsHistory.indexOf("const videoJobPending", authEffectStart);
  if (authEffectStart < 0 || authEffectEnd < 0) throw new Error("Ads History Insights auth effect boundaries are missing");
  const authEffect = adsHistory.slice(authEffectStart, authEffectEnd);
  for (const marker of [
    "if (!isHistoryView || !isAdminMode) return",
    "getSupabaseAccessToken()",
    "/api/crm/auth-context?workspaceId=",
    "Authorization: `Bearer ${accessToken}`",
    "authBody.data.isAdmin !== true",
    "authBody.data.workspaceId !== workspaceId",
    "/api/crm/meta-insights-history?workspaceId=",
  ]) {
    if (!authEffect.includes(marker)) throw new Error(`Ads History server auth is missing ${marker}`);
  }
  if (authEffect.indexOf("/api/crm/meta-insights-history?workspaceId=") < authEffect.indexOf("authBody.data.isAdmin !== true")) {
    throw new Error("Ads History must verify server admin access before requesting Insights");
  }
  if (authEffect.indexOf("if (!isHistoryView || !isAdminMode) return") > authEffect.indexOf("getSupabaseAccessToken()")) {
    throw new Error("Ads History client mode must exit before reading a Supabase session");
  }
  if (authEffect.includes("localStorage")) {
    throw new Error("Ads History must not cache Meta Insights in localStorage");
  }

  for (const marker of [
    "isServerLaunchUuid(item.id)",
    'historyInsightsAccess === "confirmed"',
    "Insights доступны",
    "Фактический расход Meta",
    "Лиды по данным Meta",
    "Insights ещё не синхронизированы",
    "Meta не вернула данные за выбранный период",
    "Синхронизация выполняется",
    "Insights недоступны для этого запуска",
    "Фактический расход Meta показывается отдельно от планового бюджета.",
    "Лиды по данным Meta не равны заявкам CRM.",
    "Это не оценка эффективности рекламы.",
    "Подтвердите админ-доступ для просмотра Meta Insights.",
    "formatMetaInsightsMinor",
    "BigInt(spendMinor)",
  ]) {
    if (!adsHistory.includes(marker)) throw new Error(`Ads History Insights UI is missing ${marker}`);
  }
  if (adsHistory.includes('"/api/crm/meta-insights-sync"')) {
    throw new Error("Ads History must not add a manual Insights synchronization trigger");
  }
  if (/\b(?:CPL|ROI|ROMI)\b/.test(adsHistory)) {
    throw new Error("Ads History must not calculate or display CPL, ROI or ROMI");
  }
  const insightsPanel = adsHistory.slice(
    adsHistory.indexOf("function MetaInsightsHistoryDetails"),
    adsHistory.indexOf("function FeatureBadge"),
  );
  for (const marker of ["min-w-0", "sm:grid-cols-2", "break-words"]) {
    if (!insightsPanel.includes(marker)) throw new Error(`Ads History Insights mobile layout is missing ${marker}`);
  }
  if (/\breach\b/.test(insightsPanel)) {
    throw new Error("Ads History Insights UI must not display aggregate reach");
  }

  for (const marker of [
    "## CRM11d: read-only Insights в истории рекламы",
    "активную роль `owner` или `admin`",
    "meta_campaign_launches.id = meta_campaign_insights.meta_campaign_launch_id",
    "Client mode не получает access token",
    "Local/demo-запуски исключены",
    "Разные валюты не объединяются",
    "`reach` намеренно отсутствует",
    "Meta action metric, а не заявки CRM",
    "только в Admin Center; в Ads History нет sync-кнопки.",
    "не рассчитывает CPL, ROI, ROMI",
  ]) {
    if (!doc.includes(marker)) throw new Error(`CRM11d documentation is missing ${marker}`);
  }

  console.log("Meta Insights Ads History foundation checks: ok");
}

async function checkMetaInsightsSchedulerFoundation() {
  const migration = await readFile(
    path.join(
      repoRoot,
      "migrations",
      "022_meta_insights_scheduler_foundation.sql",
    ),
    "utf8",
  );
  const evaluator = await readFile(
    path.join(repoRoot, "lib", "meta", "insightsCompleteness.ts"),
    "utf8",
  );
  const tests = await readFile(
    path.join(repoRoot, "scripts", "src", "meta-insights-completeness.test.ts"),
    "utf8",
  );
  const rootPackage = await readFile(
    path.join(repoRoot, "package.json"),
    "utf8",
  );
  const scriptsPackage = await readFile(
    path.join(repoRoot, "scripts", "package.json"),
    "utf8",
  );
  const apiSource = await readFile(
    path.join(repoRoot, "api", "crm", "[...path].ts"),
    "utf8",
  );
  const doc = await readFile(
    path.join(repoRoot, "docs", "META-INSIGHTS-FOUNDATION.md"),
    "utf8",
  );

  for (const marker of [
    "create table if not exists public.meta_insights_sync_state",
    "workspace_id uuid not null references public.workspaces(id) on delete cascade",
    "meta_campaign_launch_id uuid not null references public.meta_campaign_launches(id) on delete cascade",
    "next_sync_at timestamptz",
    "last_attempt_at timestamptz",
    "last_success_at timestamptz",
    "last_complete_date date",
    "completeness_status text not null default 'never_synced'",
    "consecutive_failure_count integer not null default 0",
    "lease_owner text",
    "lease_expires_at timestamptz",
    "last_error_code text",
    "paused_until timestamptz",
    "pause_reason text",
    "unique (workspace_id, meta_campaign_launch_id)",
    "meta_insights_sync_state_lease_pair_check",
    "meta_insights_sync_state_workspace_next_sync_idx",
    "meta_insights_sync_state_workspace_status_next_sync_idx",
    "meta_insights_sync_state_workspace_lease_expires_idx",
    "meta_insights_sync_state_workspace_paused_until_idx",
    "alter table public.meta_insights_sync_state enable row level security",
    "grant all on table public.meta_insights_sync_state to service_role",
  ]) {
    if (!migration.includes(marker))
      throw new Error(`migration 022 is missing ${marker}`);
  }
  for (const status of [
    "never_synced",
    "syncing",
    "zero_delivery",
    "partial",
    "current",
    "stale",
    "failed",
    "unavailable",
  ]) {
    if (!migration.includes(`'${status}'`))
      throw new Error(`migration 022 is missing completeness status ${status}`);
  }
  for (const marker of [
    `"trigger" text not null default 'manual'`,
    "request_key text",
    "attempt integer not null default 1",
    "pages_fetched integer not null default 0",
    "coverage_complete boolean not null default false",
    "heartbeat_at timestamptz",
    `check ("trigger" in ('manual', 'background', 'operator'))`,
    "check (attempt >= 1)",
    "check (pages_fetched >= 0)",
    "meta_insights_sync_runs_workspace_request_key_idx",
    "meta_insights_sync_runs_workspace_trigger_created_idx",
    "meta_insights_sync_runs_workspace_coverage_finished_idx",
    "meta_insights_sync_runs_workspace_heartbeat_idx",
    "mark_manual_meta_insights_coverage_complete",
  ]) {
    if (!migration.includes(marker))
      throw new Error(`migration 022 sync-run extension is missing ${marker}`);
  }

  for (const marker of [
    "claim_due_meta_insights_sync_states",
    "for update skip locked",
    "state.next_sync_at <= now()",
    "state.paused_until is null or state.paused_until <= now()",
    "state.lease_expires_at is null or state.lease_expires_at <= now()",
    "state.workspace_id = any(p_workspace_ids)",
    "least(greatest(coalesce(p_limit, 1), 1), 50)",
    "completeness_status = 'syncing'",
    "security definer",
    "set search_path = pg_catalog, public",
    "revoke all on function public.claim_due_meta_insights_sync_states",
    "grant execute on function public.claim_due_meta_insights_sync_states",
  ]) {
    if (!migration.toLowerCase().includes(marker.toLowerCase())) {
      throw new Error(`migration 022 atomic claim is missing ${marker}`);
    }
  }
  for (const forbidden of [
    "access_token",
    "app_secret",
    "worker_secret",
    "service_role_key",
    "raw_response",
    "paging_url",
  ]) {
    if (migration.toLowerCase().includes(forbidden)) {
      throw new Error(`migration 022 must not store or expose ${forbidden}`);
    }
  }

  for (const marker of [
    "META_INSIGHTS_COMPLETENESS_STATUSES",
    "mergeMetaInsightsDateRanges",
    "findMetaInsightsUnknownGaps",
    "isMetaInsightsLeaseActive",
    "evaluateMetaInsightsCompleteness",
    "accountTimeZone must be explicit",
    "coverageComplete",
    "completedAt",
    "insightRowCountInRequiredRange === 0",
    '"zero_delivery"',
    '"current"',
    '"stale"',
    '"failed"',
  ]) {
    if (!evaluator.includes(marker))
      throw new Error(
        `Meta Insights completeness evaluator is missing ${marker}`,
      );
  }
  for (const forbidden of [
    "process.env",
    "createClient",
    "supabase",
    "fetch(",
    "accessToken",
    "reach",
  ]) {
    if (evaluator.includes(forbidden)) {
      throw new Error(
        `Meta Insights completeness evaluator must stay pure and omit ${forbidden}`,
      );
    }
  }
  for (const marker of [
    "fully covered successful zero-row range is zero_delivery",
    "expired lease can be reclaimed",
    "internal uncovered day",
    "failed attempt does not erase fresh complete coverage",
    "overlapping successful ranges merge",
    "adjacent successful ranges merge",
    "workspace allowlist",
    "request key uniqueness",
    "existing manual sync runs remain compatible",
  ]) {
    if (!tests.includes(marker))
      throw new Error(`Meta Insights completeness tests are missing ${marker}`);
  }
  if (
    !rootPackage.includes('"test:insights-completeness"') ||
    !scriptsPackage.includes('"test:insights-completeness"')
  ) {
    throw new Error(
      "Meta Insights completeness executable test command is missing",
    );
  }

  for (const forbiddenRoute of [
    'resource === "meta-insights-cron"',
    'resource === "meta-insights-scheduler"',
    'resource === "meta-insights-worker"',
  ]) {
    if (apiSource.includes(forbiddenRoute))
      throw new Error(`CRM11e.1 must not add ${forbiddenRoute}`);
  }

  for (const marker of [
    "## CRM11e.1: scheduler state и completeness foundation",
    "одна scheduler-state строка",
    "на один launch внутри workspace",
    "FOR UPDATE SKIP LOCKED",
    "request_key",
    "zero_delivery",
    "unknown gap",
    "coverage_complete = true",
    "server-to-server",
    "Фоновый worker и cron endpoint в CRM11e.1",
    "Ручная синхронизация остаётся защищённой",
    "CPL, ROI и ROMI",
  ]) {
    if (!doc.includes(marker))
      throw new Error(`CRM11e.1 documentation is missing ${marker}`);
  }

  console.log("Meta Insights scheduler and completeness foundation checks: ok");
}

async function checkLayoutFoundation() {
  const pagesDir = path.join(repoRoot, "artifacts", "negis", "src", "pages");
  const layoutDir = path.join(repoRoot, "artifacts", "negis", "src", "components", "layout");

  // AI Control Center UI MVP exists and is routed.
  const acc = await readFile(path.join(pagesDir, "AiControlCenter.tsx"), "utf8");
  for (const marker of [
    "AI Control Center",
    "Главная картина клиники",
    "Новые заявки",
    "Необработанные лиды",
    "Записи сегодня",
    "Пациенты для повторного визита",
    "Реклама требует внимания",
    "Выручка сегодня",
    "AI-рекомендации",
    "Данные появятся после подключения CRM.",
    "Запустить рекламу",
    "Открыть историю запусков",
    '"/ads-automation"',
    '"/ads-automation/history"',
    '"/content-studio"',
    "Безопасный режим",
    "Реклама в Negis OS создаётся выключенной. Включить её можно вручную в Meta Ads Manager.",
    "AI помогает находить действия, но важные решения подтверждает пользователь.",
    // D3B operational data (real sources, graceful degradation)
    "/api/crm/meta-launches",
    "/api/crm/health",
    "/api/crm/storage-health",
    "/api/targeting/health",
    "Запусков пока нет.",
    "Готовность систем",
    "Проверьте неудачный запуск рекламы",
    // CRM5 — real CRM counts wired from the existing endpoints
    "/api/crm/leads",
    "/api/crm/clients",
    "/api/crm/appointments",
    // CRM9d — real deal revenue for the current local date.
    "/api/crm/deals",
    '"deals", "negis_demo_deals"',
    "semanticGroupForLead",
    'status === "new" || status === "in_progress"',
    "isRepeatClient",
    "Не удалось проверить",
    "paidDealsToday",
    "revenueTodayMinor",
    "pendingDealsCount",
    'str(deal.status).toLowerCase() === "paid"',
    "isTodayDate(str(deal.paidAt) || str(deal.paid_at))",
    "deal.amountMinor ?? deal.amount_minor",
    "formatRevenueMinor",
    "По оплаченным продажам за сегодня.",
    'dealsState === "unknown"',
    // Rule-based CRM recommendations (no AI calls)
    "Рекомендации формируются по данным CRM и системным статусам",
    "Обработайте новые заявки",
    "Свяжите заявки с клиентами",
    "Проверьте записи на сегодня",
    "Подготовьте повторное предложение",
    "Подтвердите оплату продаж",
    "Есть продажи в статусе ожидания оплаты:",
    // CRM10 — linked-revenue counts and recommendation (manual attribution only)
    "paidAttributedRevenueMinor",
    "paidUnattributedDealsCount",
    "Свяжите продажи с рекламными кампаниями",
    "Есть оплаченные продажи без рекламной кампании:",
    "Из них с рекламой:",
    "(связано вручную)",
    "Критичных CRM-действий пока нет.",
    // Quick actions into the CRM screens
    "Открыть заявки",
    "Открыть клиентов",
    "Открыть записи",
    "Открыть продажи",
    '"/leads"',
    '"/clients"',
    '"/appointments"',
    '"/sales"',
    // Readiness rows
    "Продажи",
    "Ожидает",
    "Частично готово",
    // CRM7 — attribution readiness (leads + meta-launches endpoints responded)
    "Атрибуция рекламы",
    // CRM8 — attribution counts + rule-based recommendation (no CPL/ROI)
    "attributedLeads",
    "unattributedLeads",
    "Свяжите заявки с рекламными кампаниями",
    "Это поможет позже считать эффективность рекламы.",
    // Sales readiness and the business flow depend on the deals endpoint response.
    '<HealthRow label="Продажи" state={dealsState} />',
    'state: dealsState === "ready" ? "active" : "pending"',
  ]) {
    if (!acc.includes(marker)) {
      throw new Error(`AI Control Center MVP is missing "${marker}"`);
    }
  }
  // Client view must not leak raw technical labels, invented revenue, or
  // ad-efficiency calculations. Documentation comments may name deferred metrics.
  for (const forbidden of [
    "publicUrl",
    "video_id",
    "raw_payload",
    "costPerLead",
    "cost_per_lead",
    "attributedRevenue",
    "returnOnInvestment",
    "return_on_investment",
    "revenueByCampaign",
    "revenue_by_campaign",
    "conversionRate",
    "conversion_rate",
    "roiValue",
    "romiValue",
    'label: "CPL"',
    'label: "ROI"',
    'label: "ROMI"',
  ]) {
    if (acc.includes(forbidden)) {
      throw new Error(`AI Control Center must not show technical label "${forbidden}"`);
    }
  }
  if (acc.includes("Будет доступно после подключения продаж.")) {
    throw new Error("AI Control Center must not keep the CRM9c revenue placeholder");
  }

  const app = await readFile(path.join(pagesDir, "..", "App.tsx"), "utf8");
  if (!app.includes('path="/ai-control-center"') || !app.includes("AiControlCenter")) {
    throw new Error("App must route /ai-control-center to the AiControlCenter page");
  }
  if (!app.includes('path="/dashboard"')) {
    throw new Error("App must keep /dashboard for compatibility");
  }

  // Sidebar reflects the new IA and never links to the retired AI Target module.
  const sidebar = await readFile(path.join(layoutDir, "Sidebar.tsx"), "utf8");
  for (const marker of ["AI Control Center", "Заявки", "CRM", "Записи", "Реклама", "Контент", "Аналитика", "AI-сотрудники", "Настройки"]) {
    if (!sidebar.includes(marker)) {
      throw new Error(`Sidebar is missing IA item "${marker}"`);
    }
  }

  // Admin identity band separates admin from the client app, without exposing secrets.
  const admin = await readFile(path.join(pagesDir, "AdminCenter.tsx"), "utf8");
  if (!admin.includes("Панель платформы · Negis OS") || !admin.includes("Admin OS")) {
    throw new Error("AdminCenter must show a distinct platform admin band");
  }
  for (const secret of ["service role key", "SERVICE_ROLE", "app_secret", "APP_SECRET"]) {
    // The admin band explicitly states secrets are not shown; ensure no secret VALUE is printed.
    if (admin.includes(`process.env.${secret}`) || admin.includes(`${secret}=`)) {
      throw new Error(`AdminCenter must not expose ${secret}`);
    }
  }

  // Dashboard keeps a link to the new main screen.
  const dashboard = await readFile(path.join(pagesDir, "Dashboard.tsx"), "utf8");
  if (!dashboard.includes("Новый главный экран: AI Control Center") || !dashboard.includes("/ai-control-center")) {
    throw new Error("Dashboard must link to /ai-control-center");
  }

  console.log("Layout foundation checks: ok");
}

async function checkThemeFoundation() {
  const negisDir = path.join(repoRoot, "artifacts", "negis", "src");

  // Default-theme CSS tokens exist (additive over --ng-*).
  const css = await readFile(path.join(negisDir, "index.css"), "utf8");
  for (const token of [
    "--negis-bg",
    "--negis-surface",
    "--negis-surface-glass",
    "--negis-border",
    "--negis-primary",
    "--negis-primary-soft",
    "--negis-secondary",
    "--negis-ai",
    "--negis-success",
    "--negis-warning",
    "--negis-error",
    "--negis-text",
    "--negis-muted",
    "--negis-radius-card",
    "--negis-shadow-card",
    ".negis-glass",
  ]) {
    if (!css.includes(token)) {
      throw new Error(`index.css is missing theme token/utility "${token}"`);
    }
  }

  // Theme preset metadata exists (no runtime switching).
  const presets = await readFile(path.join(negisDir, "lib", "themePresets.ts"), "utf8");
  for (const id of ["medical-clean", "glass-ai", "beauty-premium", "organic-care", "dark-pro", "brand-custom"]) {
    if (!presets.includes(`"${id}"`)) {
      throw new Error(`themePresets.ts is missing preset "${id}"`);
    }
  }
  if (!presets.includes('defaultThemePresetId = "glass-ai"')) {
    throw new Error("themePresets.ts must set glass-ai as the default preset");
  }

  // AI Control Center consumes the tokens.
  const acc = await readFile(path.join(negisDir, "pages", "AiControlCenter.tsx"), "utf8");
  if (!acc.includes("negis-glass") || !acc.includes("var(--negis-")) {
    throw new Error("AI Control Center must use the Negis OS theme tokens");
  }

  // Design system documents the theme system.
  const doc = await readFile(path.join(repoRoot, "docs", "DESIGN-SYSTEM.md"), "utf8");
  for (const marker of ["Theme System", "Glass Morphic Medical AI", "Theme selection must NEVER change", "brand-custom"]) {
    if (!doc.includes(marker)) {
      throw new Error(`DESIGN-SYSTEM.md theme section is missing "${marker}"`);
    }
  }

  console.log("Theme foundation checks: ok");
}

async function checkNavigationCleanup() {
  const layoutDir = path.join(repoRoot, "artifacts", "negis", "src", "components", "layout");
  const pagesDir = path.join(repoRoot, "artifacts", "negis", "src", "pages");

  // AI Target is retired as a standalone module: no visible navigation may link to it.
  for (const [name, file] of [
    ["Sidebar", path.join(layoutDir, "Sidebar.tsx")],
    ["MobileNav", path.join(layoutDir, "MobileNav.tsx")],
    ["TopNav", path.join(layoutDir, "TopNav.tsx")],
    ["Topbar", path.join(layoutDir, "Topbar.tsx")],
    ["Dashboard", path.join(pagesDir, "Dashboard.tsx")],
  ] as const) {
    const source = await readFile(file, "utf8");
    if (source.includes("targeting-agent")) {
      throw new Error(`${name} must not link to the retired AI Target module`);
    }
  }

  const app = await readFile(path.join(pagesDir, "..", "App.tsx"), "utf8");
  if (!app.includes('<Route path="/targeting-agent">') || !app.includes('<Redirect to="/ads-automation" />')) {
    throw new Error("App must redirect /targeting-agent to /ads-automation");
  }

  const contentStudio = await readFile(path.join(pagesDir, "ContentStudio.tsx"), "utf8");
  if (contentStudio.includes("Передать в ИИ таргетолог") || contentStudio.includes('setLocation("/targeting-agent")')) {
    throw new Error("Content Studio must hand off to Ads Automation, not the retired AI Target module");
  }
  if (!contentStudio.includes("transferToAdsAutomation")) {
    throw new Error("Content Studio must keep the Ads Automation handoff");
  }

  // The AI assistant stays inside Ads Automation.
  const adsAutomation = await readFile(path.join(pagesDir, "AdsAutomation.tsx"), "utf8");
  if (!adsAutomation.includes("ads-ai-fill") || !adsAutomation.includes("ИИ заполнить рекламу")) {
    throw new Error("Ads Automation must keep the built-in AI fill");
  }

  // The concept document exists with the required sections.
  const concept = await readFile(path.join(repoRoot, "docs", "AI-CONTENT-STUDIO-CONCEPT.md"), "utf8");
  for (const marker of ["Product vision", "User roles", "Generation modes", "Compliance rules", "Implementation phases", "Phase 4", "Phase 5"]) {
    if (!concept.includes(marker)) {
      throw new Error(`AI Content Studio concept doc is missing the "${marker}" section`);
    }
  }

  console.log("Navigation cleanup checks: ok");
}

async function checkNoNewApiFiles() {
  // New CRM endpoints must live inside the existing catch-all, not new api files.
  const crmFiles = (await readdir(path.join(repoRoot, "api", "crm"))).sort();
  if (crmFiles.length !== 1 || crmFiles[0] !== "[...path].ts") {
    throw new Error(`api/crm must contain only the catch-all route, found: ${crmFiles.join(", ")}`);
  }
  const apiSource = await readFile(path.join(repoRoot, "api", "crm", "[...path].ts"), "utf8");
  if (!apiSource.includes("video-processing-jobs") || !apiSource.includes("handleVideoProcessingJobs")) {
    throw new Error("api/crm catch-all must route /api/crm/video-processing-jobs");
  }
  for (const resource of ['"lead-stages"', '"lead-sources"']) {
    if (!apiSource.includes(resource)) {
      throw new Error(`api/crm catch-all must register ${resource}`);
    }
  }
  const migration = await readFile(path.join(repoRoot, "migrations", "018_video_processing_jobs_contract.sql"), "utf8");
  for (const marker of [
    "optimized_public_url",
    "input_size_bytes",
    "output_size_bytes",
    "compression_ratio",
    "error_message",
    "video_processing_jobs_status_check",
    "'deleted_original'",
  ]) {
    if (!migration.includes(marker)) {
      throw new Error(`migration 018 is missing ${marker}`);
    }
  }

  const pipelineMigration = await readFile(path.join(repoRoot, "migrations", "019_crm_lead_pipeline_foundation.sql"), "utf8");
  for (const marker of [
    "create table if not exists public.lead_stages",
    "create table if not exists public.lead_sources",
    "unique (workspace_id, stage_key)",
    "unique (workspace_id, source_key)",
    "semantic_group in ('new', 'in_progress', 'booked', 'lost')",
    "add column if not exists stage_id uuid",
    "add column if not exists source_id uuid",
    "add column if not exists meta_campaign_launch_id uuid",
    "seed_default_lead_taxonomy",
    "'legacy_' || md5",
    "having count(distinct launch.id) = 1",
  ]) {
    if (!pipelineMigration.includes(marker)) {
      throw new Error(`migration 019 is missing ${marker}`);
    }
  }

  const pipelineDoc = await readFile(path.join(repoRoot, "docs", "CRM-LEAD-PIPELINE.md"), "utf8");
  const normalizedPipelineDoc = pipelineDoc.replace(/\s+/g, " ").toLowerCase();
  for (const marker of [
    "lead_stages",
    "lead_sources",
    "Dual-write",
    "workspace_id",
    "legacy_<hash>",
    "meta_campaign_launch_id",
    // CRM7 — campaign attribution UI is documented; sales/CPL stay future scope.
    "Campaign attribution",
    "Рекламная кампания",
    "future scope",
    // CRM8 — safe counts only; efficiency and sales/deals remain deferred.
    "CRM8",
    "Связаны с рекламой",
    "Без рекламной кампании",
    "ROI/ROMI",
    "продаж/deals",
  ]) {
    if (!normalizedPipelineDoc.includes(marker.toLowerCase())) {
      throw new Error(`CRM lead pipeline documentation is missing ${marker}`);
    }
  }
  console.log("API file layout checks: ok");
}

async function checkHtmlRoute(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  if (!text.includes('<div id="root">')) {
    throw new Error(`${path} did not return the Negis app shell`);
  }

  console.log(`${path}: ok`);
}

async function checkTargetingHealth() {
  const response = await fetch(`${baseUrl}/api/targeting/health`);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`/api/targeting/health returned invalid JSON: ${text.slice(0, 120)}`);
  }

  if (!response.ok || body.success !== true) {
    const details = body.details?.join(", ");
    throw new Error(
      `/api/targeting/health failed: ${body.error || `HTTP ${response.status}`}${details ? ` (${details})` : ""}`,
    );
  }

  console.log(`/api/targeting/health: ok (${body.mode || "unknown"})`);
}

async function checkJsonEndpoint(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`${path} returned invalid JSON: ${text.slice(0, 120)}`);
  }

  if (!response.ok || body.success !== true) {
    const details = body.details?.join(", ");
    throw new Error(`${path} failed: ${body.error || `HTTP ${response.status}`}${details ? ` (${details})` : ""}`);
  }

  console.log(`${path}: ok (${body.mode || "unknown"})`);
  return body;
}

async function checkJsonFailure(path: string, init: RequestInit, expectedText?: string) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: ApiBody;

  try {
    body = JSON.parse(text) as ApiBody;
  } catch {
    throw new Error(`${path} returned invalid JSON for failure check: ${text.slice(0, 120)}`);
  }

  if (response.ok && body.success !== false) {
    throw new Error(`${path} unexpectedly succeeded`);
  }

  const combined = [body.error, ...(body.details || [])].filter(Boolean).join(" ");
  if (expectedText && !combined.includes(expectedText)) {
    throw new Error(`${path} failed with unexpected message: ${combined}`);
  }

  console.log(`${path}: expected failure ok`);
  return body;
}

async function checkCrmEndpoint(path: string, payload: Record<string, unknown>) {
  await checkJsonEndpoint(`${path}?workspaceId=demo-workspace`);
  await checkJsonEndpoint(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      ...payload,
    }),
  });
}

async function main() {
  console.log(`Smoke testing Negis routes at ${baseUrl}`);
  await checkAdsAutomationSource();
  await checkMetaMarketingSource();
  await checkMetaCityResolverModule();
  await checkMetaVideoModule();
  await checkCrmLaunchStateModule();
  await checkCrmVideoJobsModule();
  await checkVideoWorkerPackage();
  await checkNavigationCleanup();
  await checkLayoutFoundation();
  await checkThemeFoundation();
  await checkContentStudioPhaseOne();
  await checkPhotoCreativeBuilder();
  await checkLeadsPageSource();
  await checkClientsPageSource();
  await checkSalesPageSource();
  await checkCrmProductionGuards();
  await checkNoNewApiFiles();
  await checkMetaInsightsSchemaFoundation();
  await checkCrmServerAuthFoundation();
  await checkMetaInsightsSyncFoundation();
  await checkMetaInsightsHistoryFoundation();
  await checkMetaInsightsSchedulerFoundation();
  for (const route of [
    "/ai-control-center",
    "/dashboard",
    "/clients",
    "/sales",
    "/appointments",
    "/booking",
    "/reception",
    "/leads",
    "/calls",
    "/tasks",
    "/chat",
    "/market",
    "/reports",
    "/admin",
    "/ads",
    "/ads-automation",
    "/ads-automation/history",
    "/targeting-agent",
    "/content-studio",
    "/privacy",
    "/terms",
    "/data-deletion",
    "/login",
  ]) {
    await checkHtmlRoute(route);
  }
  await checkTargetingHealth();
  const crmHealth = await checkJsonEndpoint("/api/crm/health");
  await checkJsonFailure(
    "/api/crm/auth-context?workspaceId=853340e2-14e3-4e40-8414-295ec6c2abe2",
    { method: "GET" },
    "Authentication required",
  );
  await checkJsonFailure(
    "/api/crm/auth-context?workspaceId=853340e2-14e3-4e40-8414-295ec6c2abe2",
    { method: "GET", headers: { Authorization: "Bearer invalid-token" } },
    "Authentication required",
  );
  await checkJsonFailure(
    "/api/crm/meta-insights-sync",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "9eb6f100-bb6a-4f99-9719-e85c34513a03",
        metaCampaignLaunchId: "11111111-1111-4111-8111-111111111111",
        dateStart: "2026-07-01",
        dateStop: "2026-07-01",
      }),
    },
    "Authentication required",
  );
  await checkJsonFailure(
    "/api/crm/meta-insights-sync",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer invalid-token" },
      body: JSON.stringify({
        workspaceId: "9eb6f100-bb6a-4f99-9719-e85c34513a03",
        metaCampaignLaunchId: "11111111-1111-4111-8111-111111111111",
      }),
    },
    "Authentication required",
  );
  await checkJsonFailure(
    "/api/crm/meta-campaign-insights?workspaceId=9eb6f100-bb6a-4f99-9719-e85c34513a03",
    { method: "GET" },
    "Authentication required",
  );
  await checkJsonFailure(
    "/api/crm/meta-insights-history?workspaceId=9eb6f100-bb6a-4f99-9719-e85c34513a03",
    { method: "GET" },
    "Authentication required",
  );
  await checkJsonFailure(
    "/api/crm/meta-insights-history?workspaceId=9eb6f100-bb6a-4f99-9719-e85c34513a03",
    { method: "GET", headers: { Authorization: "Bearer invalid-token" } },
    "Authentication required",
  );
  const crmHealthMeta = ((crmHealth.data || {}) as { meta?: { videoOptimization?: { enabled?: unknown; thresholdMb?: unknown; maxInputMb?: unknown; rawBucket?: unknown } } }).meta;
  const healthOptimization = crmHealthMeta?.videoOptimization;
  if (!healthOptimization || healthOptimization.enabled !== false || healthOptimization.thresholdMb !== 50 || healthOptimization.maxInputMb !== 500) {
    throw new Error("/api/crm/health must expose videoOptimization config with safe defaults (disabled, 50 MB threshold, 500 MB max)");
  }
  if (healthOptimization.rawBucket !== "ad-creatives-raw") {
    throw new Error("/api/crm/health must expose the planned raw bucket without exposing secrets");
  }
  await checkJsonFailure(
    "/api/crm/video-jobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "demo-workspace", fileName: "big.mp4", mimeType: "video/mp4", fileSize: 200 * 1024 * 1024 }),
    },
    "Оптимизация",
  );
  const videoProcessingCreated = await checkJsonEndpoint("/api/crm/video-processing-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "large.mov",
      inputMimeType: "video/quicktime",
      inputSizeBytes: 120 * 1024 * 1024,
      rawPath: "private/raw/large.mov",
      rawPublicUrl: "https://example.com/should-not-be-exposed.mov",
    }),
  });
  const videoProcessingJob = ((videoProcessingCreated.data || {}) as { job?: Record<string, unknown> }).job || {};
  if (videoProcessingJob.status !== "queued" || !videoProcessingJob.id || videoProcessingJob.rawPath || videoProcessingJob.rawPublicUrl) {
    throw new Error("/api/crm/video-processing-jobs must create a safe queued job without raw URL fields");
  }
  await checkJsonEndpoint(`/api/crm/video-processing-jobs/${encodeURIComponent(String(videoProcessingJob.id))}`);
  await checkJsonFailure(
    "/api/crm/video-processing-jobs/ready-job/retry",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    },
    "Only failed jobs",
  );
  await checkJsonEndpoint("/api/crm/video-processing-jobs/failed-job/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "failed" }),
  });
  await checkJsonEndpoint("/api/crm/storage-health");
  await checkCrmEndpoint("/api/crm/clients", {
    name: "Smoke Client",
    phone: "+7 700 000 00 00",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/lead-stages", {
    stageKey: "smoke_stage",
    name: "Smoke stage",
    semanticGroup: "in_progress",
    sortOrder: 500,
    isActive: true,
  });
  await checkCrmEndpoint("/api/crm/lead-sources", {
    sourceKey: "smoke_source",
    name: "Smoke source",
    channel: "other",
    sortOrder: 500,
    isActive: true,
  });
  await checkCrmEndpoint("/api/crm/leads", {
    name: "Smoke Lead",
    phone: "+7 700 111 22 33",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/deals", {
    title: "Smoke Deal",
    amountMinor: 1500000,
  });
  await checkCrmDealsFoundation();
  await checkCrmEndpoint("/api/crm/appointments", {
    client: "Smoke Client",
    phone: "+7 700 222 33 44",
    whatsapp: "+7 700 222 33 44",
    service: "Consultation",
    doctor: "Smoke Doctor",
    starts_at: new Date().toISOString(),
    durationMinutes: 60,
    status: "scheduled",
    source: "smoke",
  });
  await checkCrmEndpoint("/api/crm/tasks", {
    title: "Smoke task",
    status: "new",
  });
  await checkCrmEndpoint("/api/crm/chat", {
    dialog: "Smoke",
    author: "Smoke",
    text: "Smoke message",
  });
  await checkCrmEndpoint("/api/crm/staff", {
    name: "Smoke Staff",
    email: "smoke@example.com",
    role: "receptionist",
  });
  await checkCrmEndpoint("/api/crm/content-videos", {
    title: "Smoke content video",
    niche: "medical marketing",
  });
  await checkCrmEndpoint("/api/crm/admin-settings", {
    key: "clinic",
    value: {
      clinicName: "Smoke Clinic",
      city: "Astana",
    },
  });
  await checkCrmEndpoint("/api/crm/integration-statuses", {
    provider: "smoke",
    status: "configured",
  });
  await checkCrmEndpoint("/api/crm/ai-providers", {
    provider: "openai",
    purpose: "smoke",
    enabled: false,
    modelName: "smoke-model",
  });
  await checkCrmEndpoint("/api/crm/meta-accounts", {
    accountName: "Smoke Meta Account",
    status: "draft",
  });
  await checkCrmEndpoint("/api/crm/meta-launches", {
    campaignName: "Smoke Meta Launch",
    status: "draft",
  });
  await checkCrmEndpoint("/api/crm/ad-creatives", {
    fileName: "smoke-creative.jpg",
    fileType: "image",
    mimeType: "image/jpeg",
    fileSize: 2048,
    publicUrl: "https://example.com/smoke-creative.jpg",
    status: "uploaded",
  });
  const metadataSave = await checkJsonEndpoint("/api/crm/ad-creatives", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-direct-upload.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 6_700_000,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/smoke-direct-upload.jpg",
      publicUrl: "https://example.com/smoke-direct-upload.jpg",
      status: "uploaded",
      metadata: {
        source: "ads-automation",
        uploadMode: "signed_url",
        signedUpload: true,
      },
    }),
  });
  const metadataAsset = (metadataSave.data || {}) as { publicUrl?: string; item?: { publicUrl?: string; storagePath?: string } };
  if (!metadataAsset.publicUrl && !metadataAsset.item?.publicUrl) {
    throw new Error("/api/crm/ad-creatives did not return publicUrl for metadata save");
  }
  if (!metadataAsset.item?.storagePath) {
    throw new Error("/api/crm/ad-creatives did not keep storagePath for metadata save");
  }
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-bad.gif",
        fileType: "image",
        mimeType: "image/gif",
        fileSize: 2048,
      }),
    },
    "Формат",
  );
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-too-large.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 10 * 1024 * 1024 + 1,
      }),
    },
    "10 MB",
  );
  await checkJsonFailure(
    "/api/crm/ad-creatives/signed-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-too-large.mp4",
        fileType: "video",
        mimeType: "video/mp4",
        fileSize: 100 * 1024 * 1024 + 1,
      }),
    },
    "100 MB",
  );
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const signedUpload = await checkJsonEndpoint("/api/crm/ad-creatives/signed-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-signed-upload.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
      }),
    });
    const signedData = (signedUpload.data || {}) as { storagePath?: string; publicUrl?: string; token?: string };
    if (!signedData.storagePath || !signedData.publicUrl || !signedData.token) {
      throw new Error("/api/crm/ad-creatives/signed-upload did not return storagePath/publicUrl/token");
    }
  } else {
    await checkJsonFailure(
      "/api/crm/ad-creatives/signed-upload",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "demo-workspace",
          fileName: "smoke-signed-upload.jpg",
          fileType: "image",
          mimeType: "image/jpeg",
          fileSize: 2048,
        }),
      },
      "SUPABASE_URL",
    );
  }
  const upload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      publicUrl: "https://example.com/smoke-upload.jpg",
      status: "uploaded",
    }),
  });
  const uploadedAsset = (upload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!uploadedAsset.publicUrl && !uploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not return publicUrl");
  }
  const snakeUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      file_name: "smoke-upload-snake.jpg",
      file_type: "image",
      mime_type: "image/jpeg",
      file_size: 2048,
      storage_bucket: "ad-creatives",
      storage_path: "demo-workspace/ads/smoke-upload-snake.jpg",
      public_url: "https://example.com/smoke-upload-snake.jpg",
      status: "uploaded",
    }),
  });
  const snakeUploadedAsset = (snakeUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!snakeUploadedAsset.publicUrl && !snakeUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize public_url to publicUrl");
  }
  const urlUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload-url.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/ads/smoke-upload-url.jpg",
      url: "https://example.com/smoke-upload-url.jpg",
      status: "uploaded",
    }),
  });
  const urlUploadedAsset = (urlUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!urlUploadedAsset.publicUrl && !urlUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize url to publicUrl");
  }
  const publicURLUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-upload-public-url.jpg",
      fileType: "image",
      mimeType: "image/jpeg",
      fileSize: 2048,
      storageBucket: "ad-creatives",
      storagePath: "demo-workspace/ads/smoke-upload-public-url.jpg",
      publicURL: "https://example.com/smoke-upload-public-url.jpg",
      status: "uploaded",
    }),
  });
  const publicURLUploadedAsset = (publicURLUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
  if (!publicURLUploadedAsset.publicUrl && !publicURLUploadedAsset.asset?.publicUrl) {
    throw new Error("/api/crm/ad-creative-upload did not normalize publicURL to publicUrl");
  }
  if (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) {
    const derivedUpload = await checkJsonEndpoint("/api/crm/ad-creative-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-upload-derived.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
        storageBucket: "ad-creatives",
        storagePath: "demo-workspace/ads/smoke-upload-derived.jpg",
        status: "uploaded",
      }),
    });
    const derivedUploadedAsset = (derivedUpload.data || {}) as { publicUrl?: string; asset?: { publicUrl?: string } };
    if (!derivedUploadedAsset.publicUrl && !derivedUploadedAsset.asset?.publicUrl) {
      throw new Error("/api/crm/ad-creative-upload did not derive publicUrl from storagePath");
    }
  }
  await checkJsonFailure(
    "/api/crm/ad-creative-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-upload-missing-url.jpg",
        fileType: "image",
        mimeType: "image/jpeg",
        fileSize: 2048,
        status: "demo",
      }),
    },
    "публичную ссылку",
  );
  await checkJsonEndpoint("/api/crm/ad-creative-meta-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      fileName: "smoke-video.mp4",
      fileType: "video",
      mimeType: "video/mp4",
      publicUrl: "https://example.com/smoke-video.mp4",
      dryRun: true,
    }),
  });
  const blockedVideoMetaUpload = await checkJsonFailure(
    "/api/crm/ad-creative-meta-upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        fileName: "smoke-video.mov",
        fileType: "video",
        mimeType: "video/quicktime",
        publicUrl: "https://example.com/smoke-video.mov",
        dryRun: false,
      }),
    },
    "автозапуск видео-рекламы",
  );
  if (((blockedVideoMetaUpload.data || {}) as { metaApiCalled?: unknown }).metaApiCalled !== false) {
    throw new Error("/api/crm/ad-creative-meta-upload must not call Meta API while video launch flag is disabled");
  }
  await checkJsonEndpoint("/api/crm/ads-ai-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      creativeType: "image",
      creativeUrl: "https://example.com/smoke-creative.jpg",
      service: "Consultation",
      city: "Astana",
      leadDestination: "whatsapp",
      destinationValue: "+77000000000",
      dailyBudget: 20,
      offer: "Consultation",
      knownAudience: "Women 25-55",
      restrictions: "Safe medical wording",
    }),
  });
  await checkJsonEndpoint("/api/crm/meta-validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      dryRun: true,
    }),
  });
  const cityKeyCheck = await checkJsonEndpoint(`/api/crm/meta-city-key?city=${encodeURIComponent("Астана")}`);
  const cityKeyData = (cityKeyCheck.data || {}) as {
    key?: unknown;
    source?: unknown;
    geoMode?: unknown;
    fallbackCountry?: unknown;
    selected?: { key?: unknown; name?: unknown } | null;
    candidates?: unknown[];
    rejectedCandidates?: unknown[];
  };
  if (cityKeyData.key !== "1301648" || cityKeyData.source !== "static" || cityKeyData.geoMode !== "city" || cityKeyData.fallbackCountry !== false) {
    throw new Error("/api/crm/meta-city-key must resolve Astana to static city key 1301648");
  }
  if (!cityKeyData.selected || cityKeyData.selected.key !== "1301648" || !Array.isArray(cityKeyData.candidates) || !Array.isArray(cityKeyData.rejectedCandidates)) {
    throw new Error("/api/crm/meta-city-key must return selected/candidates/rejectedCandidates diagnostics");
  }
  const aktobeCityKeyCheck = await checkJsonEndpoint(`/api/crm/meta-city-key?city=${encodeURIComponent("Актобе")}`);
  const aktobeCityKeyData = (aktobeCityKeyCheck.data || {}) as {
    key?: unknown;
    source?: unknown;
    geoMode?: unknown;
    fallbackCountry?: unknown;
    selected?: { key?: unknown; name?: unknown } | null;
  };
  if (
    aktobeCityKeyData.key !== "1289458" ||
    aktobeCityKeyData.source !== "static" ||
    aktobeCityKeyData.geoMode !== "city" ||
    aktobeCityKeyData.fallbackCountry !== false ||
    aktobeCityKeyData.selected?.key !== "1289458"
  ) {
    throw new Error("/api/crm/meta-city-key must resolve Aktobe to static city key 1289458");
  }
  await checkJsonFailure(
    "/api/crm/meta-launch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        campaignName: "Smoke Meta Campaign missing creative URL",
        objective: "OUTCOME_LEADS",
        statusMode: "PAUSED",
        dailyBudget: 20,
        totalBudget: 140,
        currency: "USD",
        city: "Astana",
        targetAudience: "Women 25-55",
        primaryText: "Professional consultation in Astana. Book a specialist consultation.",
        headline: "Consultation in Astana",
        description: "Book a consultation with a specialist.",
        cta: "LEARN_MORE",
        landingUrl: "https://example.com",
        creativeType: "image",
        complianceConfirmed: true,
        manualApprovalConfirmed: true,
        dryRun: false,
      }),
    },
    "Креатив",
  );
  const aktobeLaunch = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Campaign Aktobe",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Актобе",
      selectedCityId: "aktobe",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Aktobe. Book a specialist consultation.",
      headline: "Consultation in Aktobe",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      imageUrl: "https://example.com/smoke-creative.jpg",
      creativeType: "image",
      creativeUrl: "https://example.com/smoke-creative.jpg",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const aktobeAdSetPayload = (((aktobeLaunch.data || {}) as { metaPayload?: { adSet?: Record<string, unknown> } }).metaPayload?.adSet || {}) as {
    targeting?: {
      geo_locations?: { countries?: unknown; cities?: Array<{ key?: unknown; radius?: unknown; distance_unit?: unknown }> };
    };
    targetingDebug?: { cityKey?: unknown; usesRadius?: unknown; fallbackCountry?: unknown; cityRadiusKm?: unknown };
  };
  const aktobeAdSetCity = aktobeAdSetPayload.targeting?.geo_locations?.cities?.[0] || {};
  if (aktobeAdSetCity.key !== "1289458") {
    throw new Error("/api/crm/meta-launch dry-run Aktobe targeting must use static city key 1289458");
  }
  if (Object.prototype.hasOwnProperty.call(aktobeAdSetCity, "radius") || Object.prototype.hasOwnProperty.call(aktobeAdSetCity, "distance_unit")) {
    throw new Error("/api/crm/meta-launch dry-run Aktobe city targeting must not include radius or distance_unit");
  }
  if (Object.prototype.hasOwnProperty.call(aktobeAdSetPayload.targeting?.geo_locations || {}, "countries")) {
    throw new Error("/api/crm/meta-launch dry-run Aktobe targeting must not fallback to countries when city key is found");
  }
  if (aktobeAdSetPayload.targetingDebug?.usesRadius !== false || aktobeAdSetPayload.targetingDebug?.cityRadiusKm !== "-") {
    throw new Error("/api/crm/meta-launch dry-run Aktobe debug must expose usesRadius false and cityRadiusKm '-'");
  }
  const launch = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Campaign",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Astana",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Astana. Book a specialist consultation.",
      headline: "Consultation in Astana",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://wa.me/77000000000",
      imageUrl: "https://example.com/smoke-creative.jpg",
      creativeType: "image",
      creativeUrl: "https://example.com/smoke-creative.jpg",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const launchData = (launch.data || {}) as {
    metaCampaignId?: string;
    metaStatus?: string;
    status?: string;
    launch?: { status?: string };
    metaPayload?: {
      campaign?: Record<string, unknown>;
      adSet?: Record<string, unknown>;
      creative?: Record<string, unknown>;
      ad?: Record<string, unknown>;
      launchTimestamp?: string;
    };
    launchTimestamp?: string;
  };
  const campaignPayload = launchData.metaPayload?.campaign || {};
  const adSetPayload = launchData.metaPayload?.adSet || {};
  const creativePayload = launchData.metaPayload?.creative || {};
  const adPayload = launchData.metaPayload?.ad || {};
  const launchTimestamp = launchData.launchTimestamp || launchData.metaPayload?.launchTimestamp || "";
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}$/.test(launchTimestamp)) {
    throw new Error("/api/crm/meta-launch dry-run must return launchTimestamp in YYYY-MM-DD_HH-mm format");
  }
  const payloadNames = [campaignPayload.name, adSetPayload.name, creativePayload.name, adPayload.name].map((value) =>
    typeof value === "string" ? value : "",
  );
  if (payloadNames.some((name) => !name.includes(launchTimestamp))) {
    throw new Error("/api/crm/meta-launch dry-run must use one timestamp across campaign/adset/creative/ad names");
  }
  if (campaignPayload.is_adset_budget_sharing_enabled !== false) {
    throw new Error("/api/crm/meta-launch dry-run campaign payload must contain is_adset_budget_sharing_enabled: false");
  }
  if (Object.prototype.hasOwnProperty.call(campaignPayload, "daily_budget")) {
    throw new Error("/api/crm/meta-launch dry-run campaign payload must not contain campaign-level daily_budget");
  }
  if (adSetPayload.daily_budget !== "2000") {
    throw new Error('/api/crm/meta-launch dry-run adset payload must keep daily_budget "2000" at ad set level');
  }
  if (Object.prototype.hasOwnProperty.call(adSetPayload, "lifetime_budget")) {
    throw new Error("/api/crm/meta-launch dry-run adset payload must not contain lifetime_budget when daily budget is used");
  }
  if (Object.prototype.hasOwnProperty.call(adSetPayload, "end_time")) {
    throw new Error("/api/crm/meta-launch dry-run adset payload must not contain end_time when daily budget is used");
  }
  if (adSetPayload.billing_event !== "IMPRESSIONS") {
    throw new Error("/api/crm/meta-launch dry-run adset payload must include billing_event IMPRESSIONS");
  }
  if (adSetPayload.optimization_goal !== "LINK_CLICKS") {
    throw new Error("/api/crm/meta-launch dry-run adset payload must include optimization_goal LINK_CLICKS");
  }
  if (adSetPayload.bid_strategy !== "LOWEST_COST_WITHOUT_CAP") {
    throw new Error("/api/crm/meta-launch dry-run adset payload must include bid_strategy LOWEST_COST_WITHOUT_CAP");
  }
  if (!adSetPayload.campaign_id) {
    throw new Error("/api/crm/meta-launch dry-run adset payload must include campaign_id");
  }
  if (Object.prototype.hasOwnProperty.call(adSetPayload, "targeting_automation")) {
    throw new Error("/api/crm/meta-launch dry-run adset payload must keep targeting_automation inside targeting");
  }
  const adSetTargeting = (adSetPayload.targeting || {}) as {
    geo_locations?: { countries?: unknown; cities?: Array<{ key?: unknown; radius?: unknown; distance_unit?: unknown }> };
    targeting_automation?: { advantage_audience?: unknown };
    publisher_platforms?: unknown[];
    instagram_positions?: unknown[];
  };
  const adSetTargetingDebug = (adSetPayload.targetingDebug || {}) as {
    selectedCity?: { id?: unknown; labelRu?: unknown; canonicalName?: unknown };
    cityId?: unknown;
    cityKey?: unknown;
    cityRadiusKm?: unknown;
    usesRadius?: unknown;
    candidates?: unknown[];
    rejectedCandidates?: unknown[];
    fallbackCountry?: unknown;
  };
  if (!Array.isArray(adSetTargeting.geo_locations?.cities) || adSetTargeting.geo_locations?.cities?.[0]?.key !== "1301648") {
    throw new Error("/api/crm/meta-launch dry-run Astana targeting must use static city key 1301648 when city key is available");
  }
  if (Object.prototype.hasOwnProperty.call(adSetTargeting.geo_locations || {}, "countries")) {
    throw new Error("/api/crm/meta-launch dry-run Astana targeting must not use country-only mode when city key is available");
  }
  const astanaCity = adSetTargeting.geo_locations?.cities?.[0] || {};
  if (Object.prototype.hasOwnProperty.call(astanaCity, "radius") || Object.prototype.hasOwnProperty.call(astanaCity, "distance_unit")) {
    throw new Error("/api/crm/meta-launch dry-run Astana city targeting must not include radius or distance_unit");
  }
  if (adSetTargeting.targeting_automation?.advantage_audience !== 0) {
    throw new Error("/api/crm/meta-launch dry-run targeting must include targeting_automation.advantage_audience: 0");
  }
  if (adSetTargetingDebug.selectedCity?.id !== "astana" || adSetTargetingDebug.cityKey !== "1301648") {
    throw new Error("/api/crm/meta-launch dry-run targeting debug must expose selected city and city key");
  }
  if (!Array.isArray(adSetTargetingDebug.candidates) || !Array.isArray(adSetTargetingDebug.rejectedCandidates)) {
    throw new Error("/api/crm/meta-launch dry-run targeting debug must expose candidates and rejectedCandidates arrays");
  }
  if (adSetTargetingDebug.usesRadius !== false || adSetTargetingDebug.cityRadiusKm !== "-") {
    throw new Error("/api/crm/meta-launch dry-run targeting debug must expose usesRadius false and cityRadiusKm '-'");
  }
  const publisherPlatforms = (adSetTargeting.publisher_platforms || []).map(String);
  const instagramPositions = (adSetTargeting.instagram_positions || []).map(String);
  if (JSON.stringify(publisherPlatforms) !== JSON.stringify(["instagram"])) {
    throw new Error('/api/crm/meta-launch dry-run targeting must include publisher_platforms ["instagram"]');
  }
  if (!["stream", "story", "explore", "reels"].every((position) => instagramPositions.includes(position))) {
    throw new Error("/api/crm/meta-launch dry-run targeting must include Instagram positions");
  }
  for (const forbidden of ["facebook", "messenger", "whatsapp", "threads"]) {
    if (publisherPlatforms.includes(forbidden)) {
      throw new Error(`/api/crm/meta-launch dry-run targeting must not include ${forbidden} placement`);
    }
  }
  if (typeof creativePayload.usesInstagramActor !== "boolean") {
    throw new Error("/api/crm/meta-launch dry-run creative payload must expose usesInstagramActor");
  }
  if (creativePayload.instagramActorFallback !== false) {
    throw new Error("/api/crm/meta-launch dry-run creative payload must expose instagramActorFallback false");
  }
  const creativeAsset = (creativePayload.asset || {}) as { fileType?: unknown };
  if (creativeAsset.fileType !== "image") {
    throw new Error('/api/crm/meta-launch dry-run creative asset.fileType must be "image" for image assets');
  }
  if (creativePayload.objectStorySpecType !== "link_data") {
    throw new Error('/api/crm/meta-launch dry-run image creative must use objectStorySpecType "link_data"');
  }
  if (creativePayload.imageUploadMode !== "adimages") {
    throw new Error('/api/crm/meta-launch dry-run image creative must default imageUploadMode to "adimages"');
  }
  if (creativePayload.usesVideoData !== false) {
    throw new Error("/api/crm/meta-launch dry-run image creative must not use video_data");
  }
  if (creativePayload.usesLinkData !== true) {
    throw new Error("/api/crm/meta-launch dry-run image creative must use link_data");
  }
  if (creativePayload.imageHash !== true) {
    throw new Error("/api/crm/meta-launch dry-run image creative must show imageHash expected");
  }
  if (creativePayload.pictureUrl !== false) {
    throw new Error("/api/crm/meta-launch dry-run image creative must not use pictureUrl before fallback");
  }
  if (creativePayload.imageUploadCapabilityFallback !== false) {
    throw new Error("/api/crm/meta-launch dry-run image creative must expose imageUploadCapabilityFallback false");
  }
  if (campaignPayload.status !== "PAUSED" || launchData.metaStatus !== "PAUSED") {
    throw new Error("/api/crm/meta-launch dry-run must use PAUSED status");
  }
  if (launchData.status !== "dry_run") {
    throw new Error("/api/crm/meta-launch dry-run must report launch status dry_run, not a real PAUSED launch");
  }
  if (!String(launchData.metaCampaignId || "").startsWith("dryrun_")) {
    throw new Error("/api/crm/meta-launch dry-run must return a dryrun_ campaign id");
  }
  if (launchData.launch?.status !== "dry_run") {
    throw new Error("/api/crm/meta-launch dry-run history record must be saved with status dry_run");
  }
  const videoDryRun = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Video Campaign",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Astana",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Astana. Book a specialist consultation.",
      headline: "Consultation in Astana",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      creativeType: "video",
      creativeUrl: "https://example.com/smoke-creative.mp4",
      videoUrl: "https://example.com/smoke-creative.mp4",
      fileName: "smoke-creative.mp4",
      mimeType: "video/mp4",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const videoCreativePayload = ((videoDryRun.data || {}) as { metaPayload?: { creative?: Record<string, unknown> } }).metaPayload?.creative || {};
  if (videoCreativePayload.objectStorySpecType !== "video_data" || videoCreativePayload.usesVideoData !== true) {
    throw new Error('/api/crm/meta-launch dry-run video creative must stay on objectStorySpecType "video_data"');
  }
  const videoDebug = (videoCreativePayload.video || {}) as { mimeType?: unknown; videoId?: unknown; launchEnabled?: unknown };
  if (videoDebug.mimeType !== "video/mp4" || videoDebug.videoId !== false) {
    throw new Error("/api/crm/meta-launch dry-run video creative must expose video MIME and missing video_id debug");
  }
  const expectedVideoStatus = videoCreativePayload.videoLaunchEnabled ? "experimental" : "soon";
  if (videoCreativePayload.metaVideoLaunchStatus !== expectedVideoStatus || videoDebug.launchEnabled !== videoCreativePayload.videoLaunchEnabled) {
    throw new Error('/api/crm/meta-launch dry-run video creative must expose video launch flag/status debug');
  }
  const videoDryRunWarning = String(((videoDryRun.data || {}) as { warning?: unknown }).warning || "");
  if (!videoDryRunWarning.includes("обложка")) {
    throw new Error("/api/crm/meta-launch video dry-run without thumbnail must warn about the missing cover, not fail");
  }
  if (videoCreativePayload.videoDataHasImageUrl !== false) {
    throw new Error("/api/crm/meta-launch video dry-run without thumbnail must expose videoDataHasImageUrl false");
  }
  const videoDryRunWithThumb = await checkJsonEndpoint("/api/crm/meta-launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      campaignName: "Smoke Meta Video Campaign Thumb",
      objective: "OUTCOME_LEADS",
      statusMode: "PAUSED",
      dailyBudget: 20,
      totalBudget: 140,
      currency: "USD",
      city: "Astana",
      targetAudience: "Women 25-55",
      primaryText: "Professional consultation in Astana. Book a specialist consultation.",
      headline: "Consultation in Astana",
      description: "Book a consultation with a specialist.",
      cta: "LEARN_MORE",
      landingUrl: "https://example.com",
      creativeType: "video",
      creativeUrl: "https://example.com/smoke-creative.mp4",
      videoUrl: "https://example.com/smoke-creative.mp4",
      thumbnailUrl: "https://example.com/smoke-creative-thumb.jpg",
      fileName: "smoke-creative.mp4",
      mimeType: "video/mp4",
      complianceConfirmed: true,
      manualApprovalConfirmed: true,
      dryRun: true,
    }),
  });
  const thumbCreativePayload =
    ((videoDryRunWithThumb.data || {}) as { metaPayload?: { creative?: Record<string, unknown> } }).metaPayload?.creative || {};
  if (thumbCreativePayload.videoDataHasImageUrl !== true) {
    throw new Error("/api/crm/meta-launch video dry-run with thumbnail must expose videoDataHasImageUrl true");
  }
  const thumbVideoDebug = (thumbCreativePayload.video || {}) as { thumbnailUrl?: unknown; thumbnailSource?: unknown };
  if (thumbVideoDebug.thumbnailUrl !== true || thumbVideoDebug.thumbnailSource !== "auto_frame") {
    throw new Error("/api/crm/meta-launch video dry-run with thumbnail must expose thumbnail debug fields");
  }
  await checkJsonFailure(
    "/api/crm/meta-launch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "demo-workspace",
        campaignName: "Smoke Meta Video Campaign Real",
        objective: "OUTCOME_LEADS",
        statusMode: "PAUSED",
        dailyBudget: 20,
        totalBudget: 140,
        currency: "USD",
        city: "Astana",
        targetAudience: "Women 25-55",
        primaryText: "Professional consultation in Astana. Book a specialist consultation.",
        headline: "Consultation in Astana",
        description: "Book a consultation with a specialist.",
        cta: "LEARN_MORE",
        landingUrl: "https://example.com",
        creativeType: "video",
        creativeUrl: "https://example.com/smoke-creative.mp4",
        videoUrl: "https://example.com/smoke-creative.mp4",
        complianceConfirmed: true,
        manualApprovalConfirmed: true,
        dryRun: false,
      }),
    },
    "автозапуск видео-рекламы",
  );
  await checkJsonEndpoint(`/api/crm/meta-status?campaignId=${encodeURIComponent(launchData.metaCampaignId || "dryrun_campaign_smoke")}`);
  await checkCrmEndpoint("/api/crm/release-checks", {
    checkKey: "smoke-release",
    status: "passed",
    notes: "Smoke test",
  });
  await checkJsonEndpoint("/api/content-studio/videos");
  await checkJsonEndpoint("/api/content-studio/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Smoke content studio video",
      niche: "medical marketing",
      goal: "book more appointments",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/generate-script", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      niche: "medical marketing",
      goal: "book more appointments",
      audience: "clinic owners",
      style: "expert",
      duration: "30-45 seconds",
    }),
  });
  const packageGeneration = await checkJsonEndpoint("/api/content-studio/generate-package", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: "demo-workspace",
      mode: "idea",
      format: "reels",
      service: "Консультация косметолога",
      city: "Астана",
      offer: "Бесплатная консультация",
      audience: "Женщины 25-45",
      goal: "leads",
      tone: "доверительно",
    }),
  });
  const packageData = (packageGeneration.data || {}) as Record<string, unknown>;
  for (const field of ["ideaTitle", "hook", "script", "shotList", "caption", "adPrimaryText", "adHeadline", "photoPrompt", "videoPrompt", "whatsappMessage", "complianceNotes"]) {
    const value = packageData[field];
    const empty = Array.isArray(value) ? value.length === 0 : !(typeof value === "string" && value.trim());
    if (empty) {
      throw new Error(`/api/content-studio/generate-package must return ${field}`);
    }
  }
  if (packageGeneration.mode !== "demo" && packageGeneration.mode !== "openai") {
    throw new Error("/api/content-studio/generate-package must report demo or openai mode");
  }
  await checkJsonEndpoint("/api/content-studio/generate-avatar-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      style: "expert",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/generate-tapnow-prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      niche: "medical marketing",
      goal: "book more appointments",
    }),
  });
  await checkJsonEndpoint("/api/content-studio/send-telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Demo clinic video",
      hook: "Clinic leads need fast follow-up",
      script: "Demo script",
      caption: "Demo caption",
      hashtags: ["#crm", "#ai"],
    }),
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
