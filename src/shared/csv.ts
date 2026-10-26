/**
 * CSV 文本编码兜底（R31）。
 *
 * 中文 Windows 上 Excel「另存为 CSV」默认写 GBK（ANSI），浏览器按 UTF-8 读出来
 * 就是一串 U+FFFD 或「æ¬å·」这种 mojibake：表头认不出「款号」，用户只看到
 * 「第一行没找到款号」，根本想不到是编码问题。
 * 这里只放纯判断，读文件仍由渲染层做，口径能被 e2e 直接钉住。
 */

/** 一份按某种编码解出来的候选文本 */
export interface CsvDecode {
  encoding: 'utf-8' | 'gbk'
  text: string
}

/** 给 Excel 用的 UTF-8 BOM：没有它，中文表头双击打开就是乱码 */
export const CSV_BOM = '\uFEFF'

/**
 * 像不像解码失败：UTF-8 读 GBK 一定留下替换符；
 * 或者整段没有一个中日韩字、却挤满拉丁扩展字母（典型 mojibake）。
 * 纯 ASCII 的 CSV（只有款号和数字）不算乱码，别白折腾一次 GBK。
 */
export function looksGarbled(raw: string): boolean {
  if (!raw) return false
  if (raw.includes('\uFFFD')) return true
  // BOM 本身落在全角标点区，先摘掉再判断，否则带 BOM 的文件永远不会被认成乱码
  const head = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).slice(0, 400)
  if (/[\u3000-\u303F\u3400-\u9FFF\uFF00-\uFFEF]/.test(head)) return false
  return /(Ã|Â|Å|â|ä|å|æ|ç|è|é|ï»¿)/.test(head)
}

/**
 * 从几份解码结果里挑一份能用的：按传入顺序取第一份不乱码的
 * （调用方先给 UTF-8，再给 GBK，所以 UTF-8 正常时绝不会换成 GBK）。
 * 全都乱码就退回第一份非空，让服务层用表头报错说清是哪一列没认出来。
 */
export function pickCsvDecode(candidates: CsvDecode[]): CsvDecode | null {
  const usable = candidates.filter((c) => c.text.trim().length > 0)
  if (!usable.length) return null
  return usable.find((c) => !looksGarbled(c.text)) ?? usable[0]
}
