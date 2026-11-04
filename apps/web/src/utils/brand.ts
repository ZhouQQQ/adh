import type { DeviceSummary } from '@adh/protocol';
import appleLogo from '../assets/brands/apple.svg';
import honorLogo from '../assets/brands/honor.svg';
import huaweiLogo from '../assets/brands/huawei.svg';
import oppoLogo from '../assets/brands/oppo.svg';
import vivoLogo from '../assets/brands/vivo.svg';
import xiaomiLogo from '../assets/brands/xiaomi.svg';

export type BrandKey =
  | 'apple'
  | 'huawei'
  | 'xiaomi'
  | 'honor'
  | 'oppo'
  | 'vivo';

export interface BrandMeta {
  key: BrandKey;
  label: string;
  logo: string;
}

export const BRAND_META: Record<BrandKey, BrandMeta> = {
  apple: { key: 'apple', label: '苹果', logo: appleLogo },
  huawei: { key: 'huawei', label: '华为', logo: huaweiLogo },
  xiaomi: { key: 'xiaomi', label: '小米', logo: xiaomiLogo },
  honor: { key: 'honor', label: '荣耀', logo: honorLogo },
  oppo: { key: 'oppo', label: 'OPPO', logo: oppoLogo },
  vivo: { key: 'vivo', label: 'vivo', logo: vivoLogo },
};

export const BRANDS: BrandMeta[] = [
  BRAND_META.apple,
  BRAND_META.huawei,
  BRAND_META.xiaomi,
  BRAND_META.honor,
  BRAND_META.oppo,
  BRAND_META.vivo,
];

/** 把厂商名归一化到页面上的六个品牌，子品牌跟随主品牌。 */
export function deviceBrand(
  device: Pick<
    DeviceSummary,
    'platform' | 'brand' | 'marketName' | 'model' | 'name'
  >,
): BrandKey | '' {
  if (device.platform === 'ios') return 'apple';
  const text = [device.brand, device.marketName, device.model, device.name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/redmi|xiaomi|poco/.test(text)) return 'xiaomi';
  if (/honor/.test(text)) return 'honor';
  if (/huawei/.test(text)) return 'huawei';
  if (/oppo|oneplus|realme/.test(text)) return 'oppo';
  if (/vivo|iqoo/.test(text)) return 'vivo';
  return '';
}