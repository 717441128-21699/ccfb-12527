/**
 * 基线库的浏览器持久化。
 *
 * - localStorage 保存当前工位基线（key 固定，按轴承型号/转速区分由调用方命名）
 * - 导出/导入 JSON 文件，便于在多台检测台之间复制基线、纳入版本管理
 * 纯数据操作，不依赖 DSP 模块，方便单测替换。
 */

import type { BaselineData } from "../core/baseline.js";

const STORAGE_KEY = "motor-detector:baseline:v1";

export function saveBaselineLocal(data: BaselineData): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    throw new Error(`基线写入本地存储失败（可能超容量）: ${(e as Error).message}`);
  }
}

export function loadBaselineLocal(): BaselineData | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as BaselineData;
}

export function clearBaselineLocal(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function exportBaselineFile(data: BaselineData, filename = "baseline.json"): void {
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function importBaselineFile(file: File): Promise<BaselineData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(String(reader.result)) as BaselineData;
        if (obj.version !== 1 || !Array.isArray(obj.meanDb)) {
          throw new Error("文件内容不是有效的基线数据");
        }
        resolve(obj);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
