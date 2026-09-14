from pathlib import Path
import base64,html
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

R=Path(__file__).resolve().parents[1];A=R/'public/visual-assets'
cache={}
def text(s,x,y,size=24,family='instrument-sans',weight=500,color='#171714'):
    key=(family,weight)
    if key not in cache:
        f=instantiateVariableFont(TTFont(A/'fonts'/f'{family}-latin.woff2'),{'wght':weight},inplace=False)
        cache[key]=(f,f.getGlyphSet(),f.getBestCmap())
    f,g,c=cache[key];k=size/f['head'].unitsPerEm;pieces=[]
    for ch in s:
        glyph=g[c[ord(ch)]];p=SVGPathPen(g);glyph.draw(p)
        pieces.append(f'<path d="{p.getCommands()}" transform="translate({x:.2f} {y}) scale({k} {-k})"/>');x+=glyph.width*k
    return f'<g fill="{color}" aria-label="{html.escape(s)}">'+''.join(pieces)+'</g>'
def img(name,x,y,w,h):
    p=A/name;mime='image/svg+xml' if p.suffix=='.svg' else 'image/png'
    return f'<image x="{x}" y="{y}" width="{w}" height="{h}" href="data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"/>'
b='<rect width="1600" height="1260" fill="#F4F0E7"/>'
b+=img('brand/27pm-crm-horizontal.svg',52,25,300,96)
b+=text('SUITE VISUELLE / 2026',1130,83,20,color='#65625B')
b+='<path d="M64 138H1536" stroke="#171714" opacity=".18"/>'
b+=text('Les relations.',64,276,102,'newsreader',480)
b+=text('En clair.',64,389,102,'newsreader',480)
b+=text('Un même langage, du courriel au prochain projet.',70,456,25,color='#65625B')
b+=img('backgrounds/welcome-flow-cobalt.png',1050,163,486,360)
b+='<path d="M64 557H1536" stroke="#171714" opacity=".18"/>'
b+=text('01 / LES OUTILS DU QUOTIDIEN',64,605,18,color='#2846B8')
names=['inbox','contacts','pipeline','projects','tasks','settings','compose','search','reply','clock','attachment','send','calendar','lock']
for i,n in enumerate(names):b+=img('icons/'+n+'.svg',74+i*105,638,35,35)
b+=text('40 pictogrammes. Un tracé continu de 1,7 px.',64,724,21,color='#65625B')
b+='<path d="M64 770H1536" stroke="#171714" opacity=".18"/>'
b+=text('02 / UNE PLACE POUR CHAQUE ÉTAT',64,816,18,color='#2846B8')
for i,n in enumerate(['inbox-empty','accounts-empty','tasks-clear']):b+=img('illustrations/'+n+'.svg',60+i*350,847,300,210)
for i,n in enumerate(['Réception','Comptes','Tout est à jour']):b+=text(n,74+i*350,1092,23,'newsreader',480)
b+='<path d="M1150 804V1138" stroke="#171714" opacity=".18"/>'
for i,(name,col) in enumerate([('Ivoire','#F4F0E7'),('Carbone','#171714'),('Cobalt','#2846B8')]):
    x=1200+i*112;b+=f'<rect x="{x}" y="859" width="72" height="72" fill="{col}" stroke="#65625B" stroke-width=".5"/>';b+=text(name,x,963,17)
b+=text('Newsreader',1200,1033,37,'newsreader',480)
b+=text('Instrument Sans',1200,1084,25)
b+='<path d="M64 1172H1536" stroke="#171714" opacity=".18"/>'
b+=text('27PM CRM',64,1219,21,weight=650)+text('Identité • Interface • Connexion • Partage',946,1219,21,color='#65625B')
(R/'27pm-crm-suite-overview.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1260" viewBox="0 0 1600 1260" role="img"><title>27PM CRM — aperçu de la suite visuelle</title>'+b+'</svg>')
print(R/'27pm-crm-suite-overview.svg')
