from pathlib import Path
import json, html, hashlib

ROOT=Path(__file__).resolve().parents[1]
A=ROOT/'public/visual-assets'
def esc(s): return html.escape(str(s),quote=True)
def rel(p): return p.relative_to(ROOT).as_posix()
def label(p): return p.stem.replace('27pm-crm-','').replace('27pm-','').replace('-',' ').capitalize()
cats=[('brand','Identité'),('backgrounds','Fonds éditoriaux'),('patterns','Motifs'),('illustrations','États vides'),('icons','Icônes'),('app-icons','Application'),('social','Partage')]
parts=[]
for folder,title in cats:
    files=sorted((A/folder).glob('*'))
    files=[p for p in files if p.suffix in ['.png','.svg','.webp'] and p.name!='sprite.svg']
    if folder in ['backgrounds','illustrations','social','patterns','brand']:
        masters=[]
        for p in files:
            if p.suffix=='.webp':continue
            if p.suffix=='.png' and p.with_name(p.stem.replace('@2x','')+'.svg').exists():continue
            masters.append(p)
        files=masters
    cls='small-assets' if folder in ['icons','app-icons'] else 'asset-grid'
    cards=[]
    for p in files:
        links=[f'<a href="{esc(rel(p))}" download>{p.suffix[1:].upper()}</a>']
        for ext in ['.png','.webp']:
            q=p.with_suffix(ext)
            if ext=='.png' and not q.exists():q=p.with_name(p.stem+'@2x.png')
            if q!=p and q.exists():links.append(f'<a href="{esc(rel(q))}" download>{ext[1:].upper()}</a>')
        bg=' style="background:#171714"' if 'inverse' in p.stem else ''
        cards.append(f'<figure class="asset"><div class="asset-stage"{bg}><img src="{esc(rel(p))}" alt="{esc(label(p))}" loading="lazy"></div><figcaption><span>{esc(label(p))}</span><span class="downloads">'+''.join(links)+'</span></figcaption></figure>')
    parts.append(f'<section data-category="{folder}" id="{folder}"><div class="section-title"><h2>{title}</h2><span>{len(files):02d} références</span></div><div class="{cls}">'+''.join(cards)+'</div></section>')

mark='public/visual-assets/brand/27pm-mark-original-1024.png'
if not (ROOT/mark).exists():
    possibilities=list((A/'brand').glob('*.png'))
    if possibilities:mark=rel(possibilities[0])
page='''<!doctype html>
<html lang="fr-CA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>27PM CRM · Suite visuelle</title><link rel="stylesheet" href="tokens/27pm-crm.css">
<style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--pm-ivory);color:var(--pm-ink);font:15px/1.5 var(--pm-sans)}button,a{touch-action:manipulation}button,select{font:inherit}a{color:var(--pm-cobalt);text-underline-offset:4px}button{cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid var(--pm-cobalt);outline-offset:4px}header{display:flex;align-items:center;justify-content:space-between;padding:24px 5vw;border-bottom:1px solid var(--pm-line)}.brand{display:flex;gap:12px;align-items:center;font-size:24px;font-weight:720;letter-spacing:-.035em}.brand img{width:38px;height:44px;object-fit:contain}.meta{font-size:12px;text-transform:uppercase;letter-spacing:.09em}main{max-width:1600px;margin:auto;padding:0 5vw 70px}.intro{display:grid;grid-template-columns:1.3fr 1fr;gap:60px;align-items:end;padding:72px 0 64px}.eyebrow{color:var(--pm-cobalt);font-size:12px;text-transform:uppercase;letter-spacing:.1em}h1,h2,h3{font-family:var(--pm-serif);font-weight:450;letter-spacing:-.04em;line-height:1.02;margin:0}h1{font-size:clamp(54px,7vw,98px);max-width:9ch;margin-top:20px}.intro p{max-width:40ch;color:var(--pm-muted)}.palette{display:flex;gap:16px;margin-top:28px}.swatch{height:36px;width:36px;display:block;border:1px solid var(--pm-line)}.palette small{display:block;font-size:11px;margin-top:7px}.nav{display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid var(--pm-line);padding:20px 0}.nav button{background:transparent;border:1px solid var(--pm-line);padding:10px 15px;border-radius:3px;min-height:44px}.nav button[aria-pressed=true]{background:var(--pm-ink);border-color:var(--pm-ink);color:var(--pm-ivory)}section{padding:44px 0;border-top:1px solid var(--pm-line)}section[hidden]{display:none}.section-title{display:flex;justify-content:space-between;align-items:baseline;gap:20px;margin-bottom:26px}.section-title h2{font-size:36px}.section-title>span{color:var(--pm-muted);font-size:12px}.asset-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:26px}.small-assets{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:20px}.asset{margin:0;min-width:0}.asset-stage{aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;background:var(--pm-raised);border:1px solid var(--pm-line);overflow:hidden}.asset-stage img{width:100%;height:100%;object-fit:contain}.small-assets .asset-stage{aspect-ratio:1}.small-assets .asset-stage img{width:28px;height:28px}.small-assets .asset figcaption{display:block;font-size:11px}.small-assets .downloads{margin-top:6px}#app-icons .asset-stage img{width:64px;height:64px;max-width:75%;max-height:75%}#backgrounds .asset-stage{aspect-ratio:3/2}#backgrounds .asset-stage img{object-fit:contain}#brand .asset-stage{padding:24px}#illustrations .asset-stage{padding:15px}figcaption{display:flex;justify-content:space-between;gap:10px;margin-top:12px;font-size:13px}figcaption>span:first-child{overflow-wrap:anywhere}.downloads{display:flex;gap:10px;flex-wrap:wrap}.downloads a{font-size:11px;min-height:26px;display:inline-flex;align-items:center}.preview{display:grid;grid-template-columns:1fr 1fr;min-height:520px;border:1px solid var(--pm-line)}.preview-copy{padding:42px;display:flex;flex-direction:column;align-items:flex-start;justify-content:space-between}.preview-copy h3{font-size:60px;max-width:10ch}.preview-copy p{max-width:33ch;color:var(--pm-muted)}.preview-copy .action{display:inline-flex;align-items:center;min-height:46px;background:var(--pm-cobalt);color:var(--pm-ivory);padding:10px 20px;border-radius:4px;text-decoration:none}.preview-art{background:#2846b8;display:flex;align-items:center;justify-content:center;overflow:hidden}.preview-art img{width:100%;height:100%;object-fit:cover}.empty-demo{display:flex;align-items:center;justify-content:space-between;gap:30px;padding:42px 0}.empty-demo img{width:230px;height:auto}.empty-demo h3{font-size:42px}.note{color:var(--pm-muted);font-size:12px}.footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px;padding-top:30px;border-top:1px solid var(--pm-line)}
@media(max-width:900px){.intro{grid-template-columns:1fr;gap:20px;padding:45px 0}.asset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.small-assets{grid-template-columns:repeat(5,minmax(0,1fr))}.preview-copy{padding:28px}.preview-copy h3{font-size:44px}}
@media(max-width:560px){header{padding:20px}.meta{max-width:120px;text-align:right;font-size:10px}main{padding-inline:20px}.intro{padding-block:34px}.asset-grid{grid-template-columns:1fr}.small-assets{grid-template-columns:repeat(3,minmax(0,1fr))}.section-title{align-items:start}.section-title h2{font-size:30px}.preview{grid-template-columns:1fr}.preview-copy{min-height:390px}.preview-art{height:230px}.empty-demo{flex-direction:column;align-items:flex-start;padding:25px 0}.empty-demo img{align-self:center}.nav{gap:6px}.nav button{padding:9px 12px;font-size:13px}.palette{gap:22px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style></head><body>
<header><div class="brand"><img src="MARK" alt="">27PM <span style="font-size:13px;letter-spacing:.06em;font-weight:400">/ CRM</span></div><div class="meta">Suite visuelle · 01<br>Septembre 2026</div></header>
<main><div class="intro"><div><span class="eyebrow">Confiance calme</span><h1>Les relations.<br>En clair.</h1></div><div><p>Une même identité, du premier courriel au prochain projet. Des actifs précis pour un espace de travail qui respire.</p><div class="palette"><div><span class="swatch" style="background:#f4f0e7"></span><small>Ivoire</small></div><div><span class="swatch" style="background:#171714"></span><small>Carbone</small></div><div><span class="swatch" style="background:#2846b8"></span><small>Cobalt</small></div></div></div></div>
<nav class="nav" aria-label="Catégories de visuels"><button type="button" data-filter="all" aria-pressed="true">Tout voir</button>FILTERS<button type="button" data-filter="examples" aria-pressed="false">En contexte</button></nav>
<div id="asset-sections">PARTS</div>
<section data-category="examples" id="examples"><div class="section-title"><h2>En contexte</h2><span>Propositions d’intégration</span></div><div class="preview"><div class="preview-copy"><div class="brand"><img src="MARK" alt="">27PM / CRM</div><div><span class="eyebrow">Votre espace de travail</span><h3>Chaque relation compte.</h3><p>Retrouvez vos conversations, vos projets et vos prochains suivis.</p><a class="action" href="#implementation-note">Accéder au CRM</a></div><span class="note">Accès réservé à l’équipe 27PM.</span></div><div class="preview-art"><img src="public/visual-assets/backgrounds/welcome-flow-cobalt.png" alt="Champ de lignes ivoire sur cobalt"></div></div><div class="empty-demo"><div><span class="eyebrow">Réception</span><h3>Tout est à jour.</h3><p>Aucune nouvelle conversation pour le moment.</p></div><img src="public/visual-assets/illustrations/inbox-empty.svg" alt=""></div><p class="note" id="implementation-note">Aperçu visuel : le bouton ci-dessus n’ouvre pas une session. Les actions seront reliées aux fonctions existantes du CRM lors de l’intégration.</p></section>
<footer class="footer"><span>27PM · Clair pour vos clients. Solide pour vous.</span><span><a href="README.md">Guide d’intégration</a> · <a href="manifest.json" download>Inventaire</a></span></footer></main>
<script>const buttons=document.querySelectorAll('[data-filter]');const sections=document.querySelectorAll('section[data-category]');buttons.forEach(b=>b.addEventListener('click',()=>{buttons.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));sections.forEach(s=>s.hidden=b.dataset.filter!=='all'&&s.dataset.category!==b.dataset.filter)}));</script></body></html>'''
page=page.replace('MARK',mark).replace('FILTERS',''.join(f'<button type="button" data-filter="{k}" aria-pressed="false">{v}</button>' for k,v in cats)).replace('PARTS',''.join(parts))
(ROOT/'index.html').write_text(page)
entries=[]
for p in sorted(ROOT.rglob('*')):
    if not p.is_file() or p.name in ['manifest.json','validation.json']:continue
    entries.append({'path':rel(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(ROOT/'manifest.json').write_text(json.dumps({'suite':'27PM CRM','version':'1.0.0','fileCount':len(entries),'files':entries},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(entries),'bytes':sum(e['bytes'] for e in entries),'gallery':str(ROOT/'index.html')}))
