from PIL import Image, ImageDraw, ImageFont
P={"garnet-600 (primary)":"#A3153F","garnet-400 (primary/dark)":"#F06A8E","saffron-400 (accent)":"#F5B32E","saffron-700":"#8A5A00","lagoon-700 (secondary)":"#1F5F66","lagoon-300 (secondary/dark)":"#7FC4C8","paper-50 (light bg)":"#FBF6F0","sand-200 (light border)":"#E8DCCD","ink-900 (dark bg)":"#1C1219","ink-800 (dark surface)":"#2A1D26","ink-700 (text light)":"#2B1E27","mist-100 (text dark)":"#F3E9EE","success":"#2E7D4F","warning":"#965A00","danger":"#B3261E","info":"#3559A8"}
def L(h):
  c=[int(h[i:i+2],16)/255 for i in (1,3,5)];c=[x/12.92 if x<=.03928 else ((x+.055)/1.055)**2.4 for x in c];return .2126*c[0]+.7152*c[1]+.0722*c[2]
def cr(a,b):
  x,y=sorted([L(a),L(b)],reverse=True);return (x+.05)/(y+.05)
pairs=[("ink-700 on paper","#2B1E27","#FBF6F0"),("mist on ink-900","#F3E9EE","#1C1219"),("white on garnet-600","#FFFFFF","#A3153F"),("garnet-600 on paper","#A3153F","#FBF6F0"),("ink-900 on saffron-400","#1C1219","#F5B32E"),("garnet-400 on ink-900","#F06A8E","#1C1219"),("lagoon-300 on ink-800","#7FC4C8","#2A1D26"),("white on lagoon-700","#FFFFFF","#1F5F66"),("saffron-700 on paper","#8A5A00","#FBF6F0"),("white on success","#FFFFFF","#2E7D4F"),("white on warning","#FFFFFF","#965A00"),("white on danger","#FFFFFF","#B3261E"),("white on info","#FFFFFF","#3559A8"),("ink-900 on garnet-400","#1C1219","#F06A8E")]
out=[f"{n}: {cr(a,b):.2f}" for n,a,b in pairs];open("contrast.txt","w").write("\n".join(out));print("\n".join(out))
F=lambda s,b=False:ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf"%("-Bold" if b else ""),s)
W,H=1400,1000;im=Image.new("RGB",(W,H),"#FBF6F0");d=ImageDraw.Draw(im)
d.rectangle([700,0,W,H],fill="#1C1219")
d.text((40,25),"StoreForge — Garnet & Saffron",font=F(34,True),fill="#2B1E27")
d.text((740,30),"balanced light + dark",font=F(22),fill="#F3E9EE")
for i,(n,h) in enumerate(P.items()):
  x=40+(i%8)*165;y=100+(i//8)*170
  d.rounded_rectangle([x,y,x+150,y+100],12,fill=h,outline="#00000033")
  t="#2B1E27" if x<700 else "#F3E9EE"
  d.text((x,y+106),h,font=F(16,True),fill=t);d.text((x,y+128),n[:22],font=F(12),fill=t)
def card(x,y,bg,surf,txt,sub,prim,ptxt,acc,bd):
  d.rounded_rectangle([x,y,x+600,y+380],18,fill=surf,outline=bd,width=2)
  d.rectangle([x,y,x+600,y+8],fill=prim)
  d.text((x+30,y+30),"Launchpad · Today",font=F(24,True),fill=txt)
  d.text((x+30,y+68),"Revenue",font=F(14),fill=sub);d.text((x+30,y+88),"$4,820",font=F(40,True),fill=txt)
  d.rounded_rectangle([x+300,y+92,x+400,y+124],16,fill=acc);d.text((x+318,y+98),"+18.4%",font=F(16,True),fill="#1C1219")
  for j,v in enumerate([40,70,55,95,80,120,105]):
    d.rounded_rectangle([x+30+j*50,y+290-v,x+66+j*50,y+290],6,fill=prim if j==5 else bd)
  d.rounded_rectangle([x+400,y+250,x+570,y+300],12,fill=prim);d.text((x+420,y+263),"Boost product",font=F(17,True),fill=ptxt)
  d.text((x+30,y+320),"Ad Fuel: $120.00  ·  ROAS 3.1x",font=F(16),fill=sub)
card(50,500,"#FBF6F0","#FFFFFF","#2B1E27","#6B5A63","#A3153F","#FFFFFF","#F5B32E","#E8DCCD")
card(750,500,"#1C1219","#2A1D26","#F3E9EE","#BFAEB7","#F06A8E","#1C1219","#F5B32E","#4A3642")
im.save("palette.png")
