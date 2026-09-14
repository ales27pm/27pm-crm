import type { CSSProperties } from 'react';

/** Copy public/visual-assets first. Existing app font declarations remain authoritative. */
export function VisualAsset({name,alt='',width=240,height=165,style}:{name:string;alt?:string;width?:number;height?:number;style?:CSSProperties}) {
  return <img src={`/visual-assets/${name}`} alt={alt} width={width} height={height} loading="lazy" decoding="async" style={{maxWidth:'100%',height:'auto',...style}} />;
}

/** Use with icon ids listed in icons metadata; keep a visible label on the parent action. */
export function AssetIcon({id,size=24}:{id:string;size?:number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><use href={`/visual-assets/icons/sprite.svg#crm-${id}`} /></svg>;
}
