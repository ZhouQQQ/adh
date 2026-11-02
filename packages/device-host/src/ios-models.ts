/** iPhone / iPad 型号 → SoC 与内存。iOS 无法直接读 RAM，只能按型号查表。 */
export interface IosHardware {
  name: string;
  soc: string;
  cpuCores: number;
  memoryMb: number;
}

const MODELS: Record<string, IosHardware> = {
  'iPhone12,1': { name: 'iPhone 11', soc: 'A13', cpuCores: 6, memoryMb: 4096 },
  'iPhone12,3': { name: 'iPhone 11 Pro', soc: 'A13', cpuCores: 6, memoryMb: 4096 },
  'iPhone12,5': { name: 'iPhone 11 Pro Max', soc: 'A13', cpuCores: 6, memoryMb: 4096 },
  'iPhone12,8': { name: 'iPhone SE (2nd)', soc: 'A13', cpuCores: 6, memoryMb: 3072 },
  'iPhone13,1': { name: 'iPhone 12 mini', soc: 'A14', cpuCores: 6, memoryMb: 4096 },
  'iPhone13,2': { name: 'iPhone 12', soc: 'A14', cpuCores: 6, memoryMb: 4096 },
  'iPhone13,3': { name: 'iPhone 12 Pro', soc: 'A14', cpuCores: 6, memoryMb: 6144 },
  'iPhone13,4': { name: 'iPhone 12 Pro Max', soc: 'A14', cpuCores: 6, memoryMb: 6144 },
  'iPhone14,4': { name: 'iPhone 13 mini', soc: 'A15', cpuCores: 6, memoryMb: 4096 },
  'iPhone14,5': { name: 'iPhone 13', soc: 'A15', cpuCores: 6, memoryMb: 4096 },
  'iPhone14,2': { name: 'iPhone 13 Pro', soc: 'A15', cpuCores: 6, memoryMb: 6144 },
  'iPhone14,3': { name: 'iPhone 13 Pro Max', soc: 'A15', cpuCores: 6, memoryMb: 6144 },
  'iPhone14,6': { name: 'iPhone SE (3rd)', soc: 'A15', cpuCores: 6, memoryMb: 4096 },
  'iPhone14,7': { name: 'iPhone 14', soc: 'A15', cpuCores: 6, memoryMb: 6144 },
  'iPhone14,8': { name: 'iPhone 14 Plus', soc: 'A15', cpuCores: 6, memoryMb: 6144 },
  'iPhone15,2': { name: 'iPhone 14 Pro', soc: 'A16', cpuCores: 6, memoryMb: 6144 },
  'iPhone15,3': { name: 'iPhone 14 Pro Max', soc: 'A16', cpuCores: 6, memoryMb: 6144 },
  'iPhone15,4': { name: 'iPhone 15', soc: 'A16', cpuCores: 6, memoryMb: 6144 },
  'iPhone15,5': { name: 'iPhone 15 Plus', soc: 'A16', cpuCores: 6, memoryMb: 6144 },
  'iPhone16,1': { name: 'iPhone 15 Pro', soc: 'A17 Pro', cpuCores: 6, memoryMb: 8192 },
  'iPhone16,2': { name: 'iPhone 15 Pro Max', soc: 'A17 Pro', cpuCores: 6, memoryMb: 8192 },
  'iPhone17,1': { name: 'iPhone 16 Pro', soc: 'A18 Pro', cpuCores: 6, memoryMb: 8192 },
  'iPhone17,2': { name: 'iPhone 16 Pro Max', soc: 'A18 Pro', cpuCores: 6, memoryMb: 8192 },
  'iPhone17,3': { name: 'iPhone 16', soc: 'A18', cpuCores: 6, memoryMb: 8192 },
  'iPhone17,4': { name: 'iPhone 16 Plus', soc: 'A18', cpuCores: 6, memoryMb: 8192 },
  'iPhone17,5': { name: 'iPhone 16e', soc: 'A18', cpuCores: 6, memoryMb: 8192 },
  'iPhone18,1': { name: 'iPhone 17 Pro', soc: 'A19 Pro', cpuCores: 6, memoryMb: 12288 },
  'iPhone18,2': { name: 'iPhone 17 Pro Max', soc: 'A19 Pro', cpuCores: 6, memoryMb: 12288 },
  'iPhone18,3': { name: 'iPhone 17', soc: 'A19', cpuCores: 6, memoryMb: 8192 },
  'iPhone18,4': { name: 'iPhone Air', soc: 'A19 Pro', cpuCores: 6, memoryMb: 8192 },
  'iPad13,1': { name: 'iPad Air (4th)', soc: 'A14', cpuCores: 6, memoryMb: 4096 },
  'iPad13,2': { name: 'iPad Air (4th)', soc: 'A14', cpuCores: 6, memoryMb: 4096 },
  'iPad13,4': { name: 'iPad Pro 11 (3rd)', soc: 'M1', cpuCores: 8, memoryMb: 8192 },
  'iPad13,8': { name: 'iPad Pro 12.9 (5th)', soc: 'M1', cpuCores: 8, memoryMb: 8192 },
  'iPad14,1': { name: 'iPad mini (6th)', soc: 'A15', cpuCores: 6, memoryMb: 4096 },
  'iPad14,3': { name: 'iPad Pro 11 (4th)', soc: 'M2', cpuCores: 8, memoryMb: 8192 },
};

export function lookupIosHardware(productType?: string): IosHardware | null {
  if (!productType) return null;
  return MODELS[productType] ?? null;
}