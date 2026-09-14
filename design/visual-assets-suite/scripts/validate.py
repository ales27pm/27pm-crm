from pathlib import Path
from html.parser import HTMLParser
from PIL import Image,ImageChops
import xml.etree.ElementTree as ET
import json,re,hashlib

R=Path(__file__).resolve().parents[1];A=R/'public/visual-assets';errors=[]
def check(ok,message):
    if not ok:errors.append(message)
svgfiles=list(R.rglob('*.svg'))
for p in svgfiles:
    try:
        root=ET.parse(p).getroot();check(root.tag.endswith('svg'),f'Not SVG: {p}')
        check('viewBox' in root.attrib or p.name=='sprite.svg',f'Missing viewBox: {p}')
    except Exception as e:errors.append(f'{p.name}: {e}')
images=[]
for p in R.rglob('*'):
    if p.suffix not in ['.png','.webp','.ico']:continue
    try:
        with Image.open(p) as im:
            im.load();images.append({'path':str(p.relative_to(R)),'width':im.width,'height':im.height,'mode':im.mode})
    except Exception as e:errors.append(f'{p.name}: {e}')
for p in (A/'backgrounds').glob('*.png'):
    with Image.open(p) as original,Image.open(p.with_suffix('.webp')) as web:
        check(original.size==web.size and ImageChops.difference(original.convert('RGB'),web.convert('RGB')).getbbox() is None,'WebP differs: '+p.name)
for p in (A/'illustrations').glob('*.png'):
    with Image.open(p) as im:check(im.mode=='RGBA' and im.getchannel('A').getextrema()[0]==0,'Illustration alpha missing: '+p.name)
icons=json.loads((A/'icons/index.json').read_text())
check(icons['count']==40,'Icon count');check(sum(i['origin']=='existing-crm-geometry' for i in icons['icons'])==24,'Original icon count')
sprite=ET.parse(A/'icons/sprite.svg');ids={e.attrib.get('id') for e in sprite.iter()}
for i in icons['icons']:check(i['symbol_id'] in ids,'Missing sprite id: '+i['id'])
class Links(HTMLParser):
    def handle_starttag(self,tag,attrs):
        d=dict(attrs)
        for key in ['src','href']:
            if key not in d:continue
            v=d[key]
            if not v or v.startswith(('data:','http:','https:','#','mailto:')):continue
            check((R/v.split('#')[0]).is_file(),'Broken gallery reference: '+v)
Links().feed((R/'index.html').read_text())
def lum(c):
    rgb=[int(c[i:i+2],16)/255 for i in [1,3,5]]
    z=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    return .2126*z[0]+.7152*z[1]+.0722*z[2]
contrast=[]
for title,a,b in [('Carbon/ivory','#171714','#F4F0E7'),('Cobalt/ivory','#2846B8','#F4F0E7'),('Muted/ivory','#65625B','#F4F0E7'),('Success text/surface','#225C3A','#E3F1E8'),('Warning text/surface','#8A4D18','#FFF4E7'),('Danger/ivory','#B3312F','#F4F0E7')]:
    u,v=sorted([lum(a),lum(b)]);ratio=(v+.05)/(u+.05);contrast.append({'pair':title,'ratio':round(ratio,2)});check(ratio>=4.5,'Text contrast fails: '+title)
manifest=json.loads((R/'manifest.json').read_text())
for e in manifest['files']:
    p=R/e['path'];check(p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==e['sha256'],'Manifest mismatch: '+e['path'])
report={'status':'pass' if not errors else 'fail','svgFiles':len(svgfiles),'decodedImages':len(images),'icons':40,'preservedIcons':24,'illustrations':10,'generatedBackgrounds':3,'losslessWebP':True,'contrast':contrast,'images':images,'errors':errors,'limits':['Live CRM not inspected: Opera navigation unavailable.','Gallery browser rendering and interaction not verified: Cloud browser blocked local URL.','No CRM deployment or authentication behavior tested.']}
(R/'docs/validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ['images','limits']},ensure_ascii=False));raise SystemExit(bool(errors))
