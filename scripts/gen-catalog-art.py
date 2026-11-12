#!/usr/bin/env python3
"""Bundled product art for seed/fixture SKUs (replaces remote picsum photos).
Writes apps/{storefront,admin}/public/catalog/<category>-<n>.svg. Brand palette only (packages/ui/tokens.css).
Run: python3 scripts/gen-catalog-art.py"""
import os
P = dict(garnet='#A3153F', garnet4='#F06A8E', saffron='#F5B32E', saffron7='#8A5A00', lagoon='#1F5F66', lagoon3='#7FC4C8',
         paper='#FBF6F0', paper1='#F4ECE2', sand='#E8DCCD', sand5='#9C8A77', ink='#2B1E27', ink9='#1C1219', ink8='#2A1D26', mist='#F3E9EE', white='#FFFFFF')
# backdrop, floor, main, accent, detail
WAYS = [
  ('paper1', 'sand', 'garnet', 'saffron', 'ink'),
  ('lagoon3', 'lagoon', 'paper', 'garnet', 'ink9'),
  ('saffron', 'saffron7', 'ink8', 'garnet4', 'paper'),
  ('ink8', 'ink9', 'lagoon3', 'saffron', 'mist'),
]
def c(k): return P[k]

def obj(cat, m, a, d):
  if cat == 'home-garden':  # potted plant
    return f'''<path d="M300 330c-40-60-90-70-120-60 20 40 60 70 120 60z" fill="{a}"/><path d="M300 330c40-70 100-80 130-66-24 44-70 76-130 66z" fill="{a}" opacity=".85"/>
<path d="M300 340c-6-70 4-120 26-160-8 50-10 100-6 160z" fill="{a}"/><path d="M215 340h170l-22 140a16 16 0 0 1-16 14H253a16 16 0 0 1-16-14z" fill="{m}"/><rect x="205" y="330" width="190" height="28" rx="10" fill="{d}" opacity=".9"/>'''
  if cat == 'electronics':  # headphones
    return f'''<path d="M190 360v-40a110 110 0 0 1 220 0v40" fill="none" stroke="{d}" stroke-width="22" stroke-linecap="round"/>
<rect x="160" y="340" width="70" height="120" rx="30" fill="{m}"/><rect x="370" y="340" width="70" height="120" rx="30" fill="{m}"/><rect x="178" y="362" width="34" height="76" rx="16" fill="{a}"/><rect x="388" y="362" width="34" height="76" rx="16" fill="{a}"/>'''
  if cat == 'beauty':  # serum bottle + jar
    return f'''<rect x="230" y="250" width="110" height="230" rx="26" fill="{m}"/><rect x="262" y="200" width="46" height="56" rx="8" fill="{d}"/><rect x="270" y="160" width="30" height="46" rx="14" fill="{a}"/>
<rect x="248" y="330" width="74" height="70" rx="8" fill="{a}" opacity=".9"/><rect x="350" y="400" width="96" height="80" rx="18" fill="{a}"/><rect x="344" y="384" width="108" height="26" rx="10" fill="{d}"/>'''
  if cat == 'pet-supplies':  # bowl with paw
    return f'''<path d="M170 400h260l-30 80H200z" fill="{m}"/><rect x="160" y="388" width="280" height="24" rx="12" fill="{d}"/>
<g fill="{a}"><ellipse cx="300" cy="300" rx="38" ry="32"/><circle cx="252" cy="250" r="17"/><circle cx="286" cy="230" r="17"/><circle cx="322" cy="232" r="17"/><circle cx="354" cy="254" r="17"/></g>'''
  if cat == 'sports-outdoors':  # water bottle
    return f'''<rect x="245" y="220" width="110" height="262" rx="36" fill="{m}"/><rect x="266" y="176" width="68" height="52" rx="12" fill="{d}"/><path d="M334 190h26a20 20 0 0 1 0 40h-26" fill="none" stroke="{d}" stroke-width="12"/>
<rect x="245" y="300" width="110" height="60" fill="{a}"/>'''
  if cat == 'fashion-accessories':  # tote bag
    return f'''<path d="M250 280v-30a50 50 0 0 1 100 0v30" fill="none" stroke="{d}" stroke-width="14"/><path d="M190 280h220l-18 200H208z" fill="{m}"/>
<rect x="190" y="280" width="220" height="34" fill="{a}"/><circle cx="300" cy="390" r="22" fill="{a}" opacity=".9"/>'''
  if cat == 'kitchen':  # mug + steam
    return f'''<path d="M210 290h150v150a40 40 0 0 1-40 40h-70a40 40 0 0 1-40-40z" fill="{m}"/><path d="M360 320h22a38 38 0 0 1 0 76h-22" fill="none" stroke="{m}" stroke-width="20"/>
<rect x="210" y="330" width="150" height="34" fill="{a}"/><path d="M255 270c-14-22 14-30 0-56M300 270c-14-22 14-30 0-56" fill="none" stroke="{d}" stroke-width="8" stroke-linecap="round" opacity=".6"/>'''
  if cat == 'baby':  # rattle + blocks
    return f'''<circle cx="260" cy="260" r="62" fill="{m}"/><circle cx="260" cy="260" r="26" fill="{a}"/><rect x="250" y="316" width="20" height="120" rx="10" fill="{d}"/><circle cx="260" cy="444" r="22" fill="{m}"/>
<rect x="330" y="390" width="90" height="90" rx="12" fill="{a}"/><rect x="350" y="320" width="70" height="70" rx="10" fill="{m}" opacity=".85"/>'''
  if cat == 'automotive':  # tyre + wrench
    return f'''<circle cx="290" cy="380" r="100" fill="{d}"/><circle cx="290" cy="380" r="56" fill="{m}"/><circle cx="290" cy="380" r="18" fill="{a}"/>
<g fill="none" stroke="{d}" stroke-width="10" opacity=".5"><path d="M210 320l20 12M200 380h24M210 440l20-12"/></g><path d="M400 200l50 50-120 120-24-24z" fill="{a}"/><circle cx="430" cy="210" r="30" fill="{a}"/><circle cx="440" cy="200" r="12" fill="{m}"/>'''
  # office: notebook + pen
  return f'''<rect x="200" y="210" width="190" height="270" rx="14" fill="{m}"/><rect x="200" y="210" width="34" height="270" rx="10" fill="{a}"/>
<g stroke="{d}" stroke-width="6" opacity=".35" stroke-linecap="round"><path d="M260 280h100M260 320h100M260 360h70"/></g><rect x="408" y="200" width="22" height="250" rx="11" fill="{d}" transform="rotate(14 419 325)"/><path d="M398 446l12 30 14-28z" fill="{a}"/>'''

CATS = ['home-garden', 'electronics', 'beauty', 'pet-supplies', 'sports-outdoors', 'fashion-accessories', 'kitchen', 'baby', 'automotive', 'office']
out = ['apps/storefront/public/catalog', 'apps/admin/public/catalog']
for o in out: os.makedirs(o, exist_ok=True)
for cat in CATS:
  for i, (bg, fl, m, a, d) in enumerate(WAYS):
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600"><rect width="600" height="600" fill="{c(bg)}"/>
<path d="M0 470h600v130H0z" fill="{c(fl)}" opacity=".55"/><ellipse cx="300" cy="490" rx="170" ry="20" fill="{c('ink9')}" opacity=".18"/>
{obj(cat, c(m), c(a), c(d))}</svg>
'''
    for o in out:
      open(f'{o}/{cat}-{i + 1}.svg', 'w').write(svg)
print(f'{len(CATS) * len(WAYS)} images x {len(out)} apps')
