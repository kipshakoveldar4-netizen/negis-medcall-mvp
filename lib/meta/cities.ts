export type MetaCityOption = {
  id: string;
  labelRu: string;
  labelEn: string;
  canonicalName: string;
  countryCode: "KZ";
  metaKey?: string;
  aliases: string[];
};

export type MetaCitySearchCandidate = {
  key: string;
  name: string;
  type: string;
  country_code: string;
  region?: string;
  supports_city?: boolean;
  accepted: boolean;
  matchConfidence: "exact" | "rejected";
  reason?: string;
};

export const KZ_META_CITY_OPTIONS: MetaCityOption[] = [
  {
    id: "astana",
    labelRu: "Астана",
    labelEn: "Astana",
    canonicalName: "Astana",
    countryCode: "KZ",
    metaKey: "1301648",
    aliases: ["астана", "astana", "nur-sultan", "nursultan", "нур-султан"],
  },
  {
    id: "almaty",
    labelRu: "Алматы",
    labelEn: "Almaty",
    canonicalName: "Almaty",
    countryCode: "KZ",
    aliases: ["алматы", "almaty"],
  },
  {
    id: "shymkent",
    labelRu: "Шымкент",
    labelEn: "Shymkent",
    canonicalName: "Shymkent",
    countryCode: "KZ",
    aliases: ["шымкент", "shymkent"],
  },
  {
    id: "aktobe",
    labelRu: "Актобе",
    labelEn: "Aktobe",
    canonicalName: "Aktobe",
    countryCode: "KZ",
    metaKey: "1289458",
    aliases: ["актобе", "aktobe", "aqtobe", "aktoebe"],
  },
  {
    id: "karaganda",
    labelRu: "Караганда",
    labelEn: "Karaganda",
    canonicalName: "Karaganda",
    countryCode: "KZ",
    aliases: ["караганда", "karaganda"],
  },
  {
    id: "atyrau",
    labelRu: "Атырау",
    labelEn: "Atyrau",
    canonicalName: "Atyrau",
    countryCode: "KZ",
    aliases: ["атырау", "atyrau"],
  },
  {
    id: "aktau",
    labelRu: "Актау",
    labelEn: "Aktau",
    canonicalName: "Aktau",
    countryCode: "KZ",
    aliases: ["актау", "aktau"],
  },
  {
    id: "pavlodar",
    labelRu: "Павлодар",
    labelEn: "Pavlodar",
    canonicalName: "Pavlodar",
    countryCode: "KZ",
    aliases: ["павлодар", "pavlodar"],
  },
  {
    id: "kostanay",
    labelRu: "Костанай",
    labelEn: "Kostanay",
    canonicalName: "Kostanay",
    countryCode: "KZ",
    aliases: ["костанай", "kostanay"],
  },
  {
    id: "taraz",
    labelRu: "Тараз",
    labelEn: "Taraz",
    canonicalName: "Taraz",
    countryCode: "KZ",
    aliases: ["тараз", "taraz"],
  },
  {
    id: "oral",
    labelRu: "Уральск",
    labelEn: "Oral",
    canonicalName: "Oral",
    countryCode: "KZ",
    aliases: ["уральск", "oral", "uralsk"],
  },
  {
    id: "oskemen",
    labelRu: "Усть-Каменогорск",
    labelEn: "Oskemen",
    canonicalName: "Oskemen",
    countryCode: "KZ",
    aliases: ["усть-каменогорск", "oskemen", "ust-kamenogorsk"],
  },
  {
    id: "kyzylorda",
    labelRu: "Кызылорда",
    labelEn: "Kyzylorda",
    canonicalName: "Kyzylorda",
    countryCode: "KZ",
    aliases: ["кызылорда", "kyzylorda"],
  },
];

export function normalizeMetaCityToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'`]/g, "")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function findKzMetaCityOption(value: string): MetaCityOption | undefined {
  const normalized = normalizeMetaCityToken(value);
  const compact = normalized.replace(/-/g, "");

  return KZ_META_CITY_OPTIONS.find((city) => {
    if (city.id === normalized || city.id === compact) return true;
    return [city.labelRu, city.labelEn, city.canonicalName, ...city.aliases].some((alias) => {
      const normalizedAlias = normalizeMetaCityToken(alias);
      return normalizedAlias === normalized || normalizedAlias.replace(/-/g, "") === compact;
    });
  });
}

export function getKzMetaCityOption(value: string | undefined, fallbackId = "astana"): MetaCityOption {
  return findKzMetaCityOption(value || "") || findKzMetaCityOption(fallbackId) || KZ_META_CITY_OPTIONS[0];
}

export function cityOptionMatchesCandidate(option: MetaCityOption, candidateName: string): boolean {
  const primaryName = candidateName.split(",")[0] || candidateName;
  const normalizedPrimary = normalizeMetaCityToken(primaryName).replace(/-/g, "");
  const acceptedNames = [option.id, option.labelRu, option.labelEn, option.canonicalName, ...option.aliases].map((value) =>
    normalizeMetaCityToken(value).replace(/-/g, ""),
  );

  return acceptedNames.includes(normalizedPrimary);
}
