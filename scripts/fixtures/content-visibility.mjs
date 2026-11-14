// Synthetic prose only. Each case is checked against the real extension.
const source = '<p id="source">Review the <a id="link" href="#reference">peripheral configuration</a> before enabling interrupts.</p>';
const slot = (mode, style) => `const root=document.querySelector('x-reader').attachShadow({mode:'${mode}'});root.innerHTML='<div style="${style}"><slot name="body"></slot></div>';window.fixtureRoot=root;`;
const cases = [
  ['fixed-reader', `<div style="height:1px;overflow:hidden"><section style="position:fixed;inset:0">${source}</section></div>`, true, '', 'body{height:0;overflow:hidden}'],
  ['absolute-reader', `<div style="height:1px;overflow:hidden"><section style="position:absolute;inset:0">${source}</section></div>`, true, '', 'body{height:0;overflow:hidden}'],
  ['body-overflow', source, true, '', 'body{height:0;overflow:hidden}#source{margin-top:100px}'],
  ['modal-transform', `<div style="height:1px;overflow:hidden;transform:translateZ(0)"><dialog id="panel">${source}</dialog></div>`, true, "document.querySelector('#panel').showModal()"],
  ['modal-opacity', `<div style="opacity:0"><dialog id="panel">${source}</dialog></div>`, true, "document.querySelector('#panel').showModal()"],
  ['popover-transform', `<div style="height:1px;overflow:hidden;transform:translateZ(0)"><div popover id="panel">${source}</div></div>`, true, "document.querySelector('#panel').showPopover()"],
  ['modal-own-opacity', `<dialog id="panel" style="opacity:0">${source}</dialog>`, false, "document.querySelector('#panel').showModal()"],
  ['modal-inner-clip', `<dialog id="panel"><div style="height:1px;overflow:hidden">${source}</div></dialog>`, false, "document.querySelector('#panel').showModal()"],
  ['paint-containment', `<div style="contain:paint;height:1px">${source}</div>`, false],
  ['empty-inset', source, false, '', '#source{clip-path:inset(50%)}'],
  ['visible-inset', source, true, '', '#source{clip-path:inset(0)}'],
  ['empty-circle', source, false, '', '#source{clip-path:circle(0)}'],
  ['empty-ellipse', source, false, '', '#source{clip-path:ellipse(0 30px)}'],
  ['empty-polygon', source, false, '', '#source{clip-path:polygon(0 0,100% 0,100% 0)}'],
  ['visible-polygon', source, true, '', '#source{clip-path:polygon(0 0,100% 0,100% 100%,0 100%)}'],
  ['crossed-polygon', source, true, '', '#source{clip-path:polygon(0 0,100% 100%,0 100%,100% 0)}'],
  ['expanded-clip-margin', `<div style="overflow:clip;overflow-clip-margin:200px;height:1px">${source}</div>`, true],
  ['hidden-ignores-clip-margin', `<div style="overflow:hidden;overflow-clip-margin:200px;height:1px">${source}</div>`, false],
  ['slot-overflow', `<x-reader>${source.replace('<p ', '<p slot="body" ')}</x-reader>`, false, slot('open', 'height:1px;overflow:hidden')],
  ['slot-opacity', `<x-reader>${source.replace('<p ', '<p slot="body" ')}</x-reader>`, false, slot('open', 'opacity:0')],
  ['visible-slot', `<x-reader>${source.replace('<p ', '<p slot="body" ')}</x-reader>`, true, slot('open', '')],
  ['closed-slot-overflow', `<x-reader>${source.replace('<p ', '<p slot="body" ')}</x-reader>`, false, slot('closed', 'height:1px;overflow:hidden'), '', false],
  ['visible-closed-slot', `<x-reader>${source.replace('<p ', '<p slot="body" ')}</x-reader>`, true, slot('closed', ''), '', false],
  ['inline-transform', `<div style="height:1px;overflow:hidden"><span style="transform:translateZ(0)">${source}</span></div>`, true, '', '#source{position:fixed;top:100px}'],
  ['clipped-fixed', `<div style="clip-path:inset(50%)">${source}</div>`, false, '', '#source{position:fixed;top:100px}'],
  ['display-none', `<div style="display:none">${source}</div>`, false],
  ['closed-popover', `<div popover id="panel">${source}</div>`, false]
];
export const visibilityCases = cases.map(([name, html, visible, setup = '', css = '', probe = true]) => ({name, html, visible, setup, css, probe}));
for (const position of ['fixed','absolute']) {
  for (const [index, css] of ['', 'position:relative', 'transform:translateZ(0)', 'translate:0px', 'rotate:0deg', 'scale:1',
    'perspective:1000px', 'filter:blur(0px)', 'backdrop-filter:blur(0px)', 'contain:layout', 'contain:paint',
    'content-visibility:auto', 'will-change:transform', 'will-change:filter', 'display:contents;transform:translateZ(0)'].entries()) {
    const visible = index===0 || index===14 || index===1 && position==='fixed';
    visibilityCases.push({name:`containing-${position}-${index}`,html:`<div style="height:1px;overflow:hidden;${css}">${source}</div>`,visible,
      setup:'',css:`#source{position:${position};top:100px;margin:0 20px}`,probe:true});
  }
}

export function visibilityFixture(test, probeBundle) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><style>
    body{margin:0;font:18px/1.5 Arial;color:#222;background:white}#source{width:500px;margin:40px 20px}
    #panel{background:white;color:#222;max-width:90vw} ${test.css}
    </style><body>${test.html}<script>${test.setup};window.visibilityFixture={link:document.querySelector('#link'),html:document.querySelector('#source').innerHTML,clicks:0};
    visibilityFixture.link.addEventListener('click',event=>{event.preventDefault();visibilityFixture.clicks++});
    </script><script>${probeBundle}</script></body></html>`;
}
