/**
 * SoC 型号 → 市场名称。
 *
 * Android 上报的 ro.soc.model 是内部型号（如 MT6991 / SM8550），
 * 这里映射成用户能认出来的名称（联发科 天玑 9400+ / 高通 骁龙 8 Gen 2）。
 */

interface SocEntry {
  vendor: string;
  name: string;
  /** 归一化后的前缀，命中任意一个即匹配 */
  match: string[];
}

const MEDIATEK = '联发科';
const QUALCOMM = '高通';
const HISILICON = '华为';
const SAMSUNG = '三星';
const GOOGLE = 'Google';
const UNISOC = '紫光展锐';

const SOC_TABLE: SocEntry[] = [
  // 联发科天玑
  { vendor: MEDIATEK, name: '天玑 9400+', match: ['MT6991'] },
  { vendor: MEDIATEK, name: '天玑 9400', match: ['MT6993'] },
  { vendor: MEDIATEK, name: '天玑 9300+', match: ['MT6989'] },
  { vendor: MEDIATEK, name: '天玑 9300', match: ['MT6983'] },
  { vendor: MEDIATEK, name: '天玑 9200+', match: ['MT6985'] },
  { vendor: MEDIATEK, name: '天玑 9200', match: ['MT6985'] },
  { vendor: MEDIATEK, name: '天玑 9000+', match: ['MT6983'] },
  { vendor: MEDIATEK, name: '天玑 8400', match: ['MT6899'] },
  { vendor: MEDIATEK, name: '天玑 8300', match: ['MT6897'] },
  { vendor: MEDIATEK, name: '天玑 8200', match: ['MT6895'] },
  { vendor: MEDIATEK, name: '天玑 8100', match: ['MT6895'] },
  { vendor: MEDIATEK, name: '天玑 1200', match: ['MT6893'] },
  { vendor: MEDIATEK, name: '天玑 1100', match: ['MT6891'] },
  { vendor: MEDIATEK, name: '天玑 1080', match: ['MT6789'] },
  { vendor: MEDIATEK, name: '天玑 900', match: ['MT6877'] },
  { vendor: MEDIATEK, name: '天玑 800', match: ['MT6873'] },
  { vendor: MEDIATEK, name: '天玑 700', match: ['MT6833'] },
  // 联发科 Helio
  { vendor: MEDIATEK, name: 'Helio G99', match: ['MT6789'] },
  { vendor: MEDIATEK, name: 'Helio G85', match: ['MT6769'] },
  { vendor: MEDIATEK, name: 'Helio G80', match: ['MT6768'] },
  { vendor: MEDIATEK, name: 'Helio P35', match: ['MT6765'] },
  { vendor: MEDIATEK, name: 'Helio P60T', match: ['MT8788', 'MT8183'] },

  // 高通骁龙
  { vendor: QUALCOMM, name: '骁龙 8 至尊版', match: ['SM8750', 'CROW'] },
  { vendor: QUALCOMM, name: '骁龙 8 Gen 3', match: ['SM8650', 'PINEAPPLE'] },
  { vendor: QUALCOMM, name: '骁龙 8 Gen 2', match: ['SM8550', 'KALAMA'] },
  { vendor: QUALCOMM, name: '骁龙 8+ Gen 1', match: ['SM8475'] },
  { vendor: QUALCOMM, name: '骁龙 8 Gen 1', match: ['SM8450', 'TARO'] },
  { vendor: QUALCOMM, name: '骁龙 888', match: ['SM8350', 'LAHAINA'] },
  { vendor: QUALCOMM, name: '骁龙 870', match: ['SM8250'] },
  { vendor: QUALCOMM, name: '骁龙 855', match: ['SM8150'] },
  { vendor: QUALCOMM, name: '骁龙 7+ Gen 3', match: ['SM7675'] },
  { vendor: QUALCOMM, name: '骁龙 7 Gen 3', match: ['SM7550'] },
  { vendor: QUALCOMM, name: '骁龙 7+ Gen 2', match: ['SM7475'] },
  { vendor: QUALCOMM, name: '骁龙 6 Gen 1', match: ['SM7435', 'PARROT'] },
  { vendor: QUALCOMM, name: '骁龙 778G', match: ['SM7325'] },
  { vendor: QUALCOMM, name: '骁龙 695', match: ['SM6375', 'HOLI'] },
  { vendor: QUALCOMM, name: '骁龙 680', match: ['SM6225'] },
  { vendor: QUALCOMM, name: '骁龙 665', match: ['SM6125'] },
  { vendor: QUALCOMM, name: '骁龙 480', match: ['SM4350'] },
  { vendor: QUALCOMM, name: '骁龙 845', match: ['SDM845'] },
  { vendor: QUALCOMM, name: '骁龙 710', match: ['SDM710'] },

  // 华为麒麟
  { vendor: HISILICON, name: '麒麟 9000', match: ['KIRIN9000'] },
  { vendor: HISILICON, name: '麒麟 990', match: ['KIRIN990'] },
  { vendor: HISILICON, name: '麒麟 985', match: ['KIRIN985'] },
  { vendor: HISILICON, name: '麒麟 980', match: ['KIRIN980'] },
  { vendor: HISILICON, name: '麒麟 810', match: ['KIRIN810'] },

  // 三星 Exynos
  { vendor: SAMSUNG, name: 'Exynos 2200', match: ['EXYNOS2200', 'S5E9925'] },
  { vendor: SAMSUNG, name: 'Exynos 2100', match: ['EXYNOS2100', 'S5E9840'] },
  { vendor: SAMSUNG, name: 'Exynos 1080', match: ['EXYNOS1080', 'S5E9810'] },
  { vendor: SAMSUNG, name: 'Exynos 990', match: ['EXYNOS990'] },

  // Google Tensor
  { vendor: GOOGLE, name: 'Tensor G4', match: ['ZUMAPRO'] },
  { vendor: GOOGLE, name: 'Tensor G3', match: ['ZUMA'] },
  { vendor: GOOGLE, name: 'Tensor G2', match: ['GS201'] },
  { vendor: GOOGLE, name: 'Tensor', match: ['GS101'] },

  // 紫光展锐
  { vendor: UNISOC, name: '虎贲 T760', match: ['UMS9230'] },
  { vendor: UNISOC, name: '虎贲 T610', match: ['UMS512'] },
];

function normalize(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s_-]/g, '');
}

function guessVendor(model: string): string | undefined {
  if (model.startsWith('MT')) return MEDIATEK;
  if (model.startsWith('SM') || model.startsWith('SDM') || model.startsWith('MSM')) {
    return QUALCOMM;
  }
  if (model.startsWith('KIRIN') || model.startsWith('HI3')) return HISILICON;
  if (model.startsWith('EXYNOS') || model.startsWith('S5E')) return SAMSUNG;
  if (model.startsWith('GS') || model.startsWith('ZUMA')) return GOOGLE;
  if (model.startsWith('UMS') || model.startsWith('SC98')) return UNISOC;
  return undefined;
}

export interface SocInfo {
  /** 厂商，如 联发科 / 高通 */
  vendor: string;
  /** 型号，如 天玑 9400+ / 骁龙 8 Gen 2 */
  model: string;
  /** 展示用，vendor + model */
  display: string;
}

/** 把内部型号转成结构化的厂商 + 市场名。命中不了就保留厂商 + 原始型号。 */
export function resolveSoc(raw: string | undefined): SocInfo | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const model = normalize(trimmed);
  if (!model) return undefined;

  for (const entry of SOC_TABLE) {
    if (entry.match.some((item) => model.startsWith(item))) {
      return {
        vendor: entry.vendor,
        model: entry.name,
        display: `${entry.vendor} ${entry.name}`,
      };
    }
  }

  const vendor = guessVendor(model);
  if (vendor) {
    return { vendor, model: trimmed, display: `${vendor} ${trimmed}` };
  }
  return { vendor: '未知', model: trimmed, display: trimmed };
}