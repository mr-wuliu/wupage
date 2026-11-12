import fs from 'node:fs/promises';
import path from 'node:path';

export async function writePdfQualityReport(output, report) {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const escape = value => String(value ?? '').replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const translated = report.results.filter(result => result.passed && result.outcome === 'translated').length;
  const rejected = report.results.filter(result => result.passed && result.outcome === 'safely-rejected').length;
  const failed = report.results.filter(result => !result.passed).length;
  const fontFallback = report.results.filter(result => result.checks?.some(check => check.fontFallbackPages?.length)).length;
  const samples = await fs.readFile(new URL('../../tests/fixtures/pdf-corpus.json', import.meta.url), 'utf8').then(JSON.parse);
  const titles = new Map(samples.map(sample => [sample.id, sample.title]));
  const modes = { baseline: '标准译文', expanded: '较长译文', 'anonymous-fonts': '隐藏字体名称' };
  const status = report.results.length < report.expectedCases ? '运行中' : failed ? '有失败项' : '已完成';
  const rows = report.results.map(result => {
    const folder = path.relative(output, result.directory).split(path.sep).map(encodeURIComponent).join('/');
    const label = !result.passed ? '测试失败' : result.outcome === 'safely-rejected' ? '已拦截不安全导出' : '排版与导出通过';
    return `<tr><td>${escape(titles.get(result.id) ?? '本地排版样本')}<br><small>${escape(result.id)}</small></td><td>${escape(result.browser)}</td><td>${escape(modes[result.mode] ?? result.mode)}</td><td>${label}</td><td>${result.pages}</td><td>${result.seconds.toFixed(1)} 秒</td><td><a href="${folder}/report.json">详情</a> · <a href="${folder}/run.log">日志</a></td></tr>`;
  }).join('');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>PDF 专项验证报告</title>
<style>body{font:16px/1.65 system-ui,sans-serif;color:#20332c;background:#f5f7f5;margin:32px auto;max-width:1200px;padding:0 24px}h1{font-size:28px}section{background:white;padding:20px 24px;border-radius:10px;margin:20px 0}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #dfe6e1}a{color:#21674f}code{overflow-wrap:anywhere}p{max-width:90ch}</style>
<h1>PDF 专项验证报告</h1><p>使用本地模拟翻译验证提取、排版、保护区域和导出。此报告不评价真实服务的翻译准确性。</p>
<section><strong>${report.sampleCount} 份真实文档 · ${report.samplePages} 页 · ${report.results.length}/${report.expectedCases} 组已运行 · ${status}</strong>
<p>正常排版 ${translated} 组；安全拦截 ${rejected} 组；测试失败 ${failed} 组。</p>
<p>其中 ${fontFallback} 组验证了字体缺字时的图像降级。降级页面保留完整视觉内容，但搜索可能不完整；它们不等同于完整的矢量文字导出。</p>
<p>安全拦截表示较长译文无法在可读字号下完整排入原版面，读取器显示问题，并已验证禁止生成截断或重叠的 PDF。它不计入正常排版成功。</p></section>
<section><table><thead><tr><th>样本</th><th>浏览器</th><th>模式</th><th>结果</th><th>检查页数（含本地样本）</th><th>用时</th><th>证据</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><p>覆盖特征：${escape(report.tags.join('、'))}</p><p>阅读器脚本 SHA-256：<code>${escape(report.buildSha256)}</code></p><p>保留区域逐像素检查与译文覆盖检查同时执行。未标注区域、扫描件 OCR、阅读顺序的语义正确性及真实译文质量仍需专项或人工验证。</p></section></html>`;
  await fs.writeFile(path.join(output, 'report.html'), html);
}
