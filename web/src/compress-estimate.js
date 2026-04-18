const PRESET_SIZE_MULTIPLIER = {
  ultrafast: 1.12,
  superfast: 1.08,
  veryfast: 1.04,
  faster: 1.02,
  fast: 1.01,
  medium: 1,
  slow: 0.97,
  slower: 0.94,
  veryslow: 0.91
};

/**
 * Rough client-side estimates. Re-encoding to H.264 MP4 from MOV/MKV/AVI is usually
 * much smaller than the source (intermediate / high bitrate), not ~80% of source.
 */
export function getCompressEstimates({
  inputBytes,
  crf,
  preset,
  inputExtension,
  outputExtension,
  convertFormat = false
}) {
  const bytes = Number(inputBytes);
  const crfValue = Number.isFinite(Number(crf)) ? Number(crf) : 23;
  const presetKey = typeof preset === "string" ? preset : "medium";
  const presetMul = Math.min(1.08, PRESET_SIZE_MULTIPLIER[presetKey] ?? 1);

  const outExt = typeof outputExtension === "string" ? outputExtension.toLowerCase() : "";
  const inExt = typeof inputExtension === "string" ? inputExtension.toLowerCase() : "";
  const converting = Boolean(convertFormat) || (inExt && outExt && inExt !== outExt);
  const heavySource =
    inExt === ".mov" || inExt === ".mkv" || inExt === ".avi" || inExt === ".webm";
  const targetIsMp4Family = outExt === ".mp4" || outExt === ".m4v";
  const crossIntoMp4 =
    targetIsMp4Family && heavySource && (inExt !== outExt || Boolean(convertFormat));

  let estimatedBytes;

  if (outExt === ".mp4" || outExt === ".m4v") {
    const deliveryRatio = crossIntoMp4
      ? mp4CrossContainerDeliveryRatio(crfValue, presetMul)
      : mp4SameFamilyRecompressRatio(crfValue, presetMul);
    const sourceAlreadyCompressed = inExt === ".mp4" || inExt === ".m4v";
    const sameContainer = !converting && inExt === outExt;
    let ratio = deliveryRatio;
    if (sourceAlreadyCompressed && (sameContainer || !converting) && !crossIntoMp4) {
      ratio *= 1.45;
    }
    ratio = clamp(ratio, 0.03, 0.55);
    estimatedBytes = Math.max(64 * 1024, Math.round(bytes * ratio));
  } else if (outExt === ".webm") {
    let ratio = mp4SameFamilyRecompressRatio(crfValue, presetMul) * 0.82;
    ratio = clamp(ratio, 0.025, 0.45);
    estimatedBytes = Math.max(64 * 1024, Math.round(bytes * ratio));
  } else if (outExt === ".mov" || outExt === ".mkv") {
    let ratio = mp4SameFamilyRecompressRatio(crfValue, presetMul) * 1.08;
    ratio = clamp(ratio, 0.04, 0.58);
    estimatedBytes = Math.max(64 * 1024, Math.round(bytes * ratio));
  } else {
    const baselineCrf = 21;
    const sizeRatioRaw = 2 ** ((baselineCrf - crfValue) / 6) * presetMul;
    const sizeRatio = clamp(sizeRatioRaw, 0.06, 0.88);
    estimatedBytes = Math.max(64 * 1024, Math.round(bytes * sizeRatio));
  }

  if (outExt === ".avi") {
    estimatedBytes = Math.round(estimatedBytes * 1.08);
  }

  const percentOfOriginal = bytes > 0 ? Math.round((estimatedBytes / bytes) * 1000) / 10 : 0;
  const savingsPercent =
    bytes > 0 && estimatedBytes < bytes ? Math.round(((bytes - estimatedBytes) / bytes) * 1000) / 10 : 0;
  const growthPercent =
    bytes > 0 && estimatedBytes > bytes ? Math.round(((estimatedBytes - bytes) / bytes) * 1000) / 10 : 0;

  const qualityReductionPercent = estimateQualityReductionPercent(crfValue, presetKey);
  const qualityRetainedPercent = Math.max(0, Math.min(100, Math.round((100 - qualityReductionPercent) * 10) / 10));

  const deliveryStyle = outExt === ".mp4" || outExt === ".m4v" || outExt === ".webm";
  const spreadLow = deliveryStyle ? 0.58 : 0.72;
  const spreadHigh = deliveryStyle ? 1.42 : 1.35;

  const lowBytes = Math.round(estimatedBytes * spreadLow);
  const highBytes = Math.round(estimatedBytes * spreadHigh);

  return {
    estimatedBytes,
    estimatedLowBytes: lowBytes,
    estimatedHighBytes: highBytes,
    percentOfOriginal,
    savingsPercent,
    growthPercent,
    qualityReductionPercent,
    qualityRetainedPercent
  };
}

/**
 * MOV/MKV/AVI/WebM → MP4/M4V: delivery H.264; baseline ~8.6% of source at CRF 23 (matches ~270 MB from ~3.1 GiB class).
 */
function mp4CrossContainerDeliveryRatio(crfValue, presetMul) {
  const base = 0.086;
  const crfShift = 2 ** ((23 - crfValue) / 5);
  return clamp(base * crfShift * presetMul, 0.036, 0.48);
}

/** Re-compress within MP4/M4V family (no cross-container into MP4). */
function mp4SameFamilyRecompressRatio(crfValue, presetMul) {
  const base = 0.072;
  const crfShift = 2 ** ((23 - crfValue) / 5);
  return clamp(base * crfShift * presetMul, 0.03, 0.42);
}

function estimateQualityReductionPercent(crfValue, presetKey) {
  const crfLoss = clamp((crfValue - 17) * 3.15, 0, 56);
  const presetLoss = presetKey === "ultrafast" ? 5 : presetKey === "superfast" ? 3 : presetKey === "veryfast" ? 1.5 : 0;
  return Math.round(clamp(crfLoss + presetLoss, 0, 62) * 10) / 10;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
