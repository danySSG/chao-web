# Синтетическое вьетнамское меню для теста разбора фото (13 блюд, лёгкий наклон и размытие).
# python3 make_menu.py  →  audio/menu.jpg
from PIL import Image, ImageDraw, ImageFont, ImageFilter
F = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 1100, 1500
im = Image.new('RGB', (W, H), (250, 244, 228)); d = ImageDraw.Draw(im)
big, h2, f, sm = (ImageFont.truetype(F, s) for s in (64, 40, 32, 24))
d.text((W // 2, 70), "QUÁN BÀ HAI", font=big, fill=(140, 30, 20), anchor="mm")
d.text((W // 2, 130), "Đặc sản Đà Nẵng · 123 Hoàng Diệu", font=sm, fill=(90, 60, 40), anchor="mm")
menu = [("MÓN NƯỚC", [("Mì Quảng gà", "45.000"), ("Bún chả cá", "40.000"), ("Phở bò tái", "50.000"), ("Bún bò Huế đặc biệt", "55.000")]),
        ("CƠM", [("Cơm gà xối mỡ", "50.000"), ("Cơm tấm sườn bì chả", "55.000")]),
        ("MÓN NHẬU", [("Bánh tráng cuốn thịt heo", "80.000"), ("Mực nướng sa tế", "120.000"), ("Ốc hút xào sả ớt", "70.000")]),
        ("NƯỚC", [("Trà đá", "5.000"), ("Nước dừa tươi", "25.000"), ("Bia Larue", "20.000"), ("Cà phê sữa đá", "20.000")])]
y = 200
for sec, items in menu:
    d.text((70, y), sec, font=h2, fill=(140, 30, 20)); y += 62
    for n, p in items:
        d.text((100, y), n, font=f, fill=(30, 30, 30)); d.text((W - 80, y), p + "đ", font=f, fill=(30, 30, 30), anchor="ra")
        d.line((100 + d.textlength(n, font=f) + 15, y + 28, W - 90 - d.textlength(p + "đ", font=f) - 15, y + 28), fill=(170, 160, 140), width=2); y += 50
    y += 22
d.text((W // 2, H - 60), "Không phục vụ mang về sau 21h · Wifi: quanbahai / 12345678", font=sm, fill=(90, 60, 40), anchor="mm")
im = im.rotate(1.5, expand=False, fillcolor=(200, 190, 170)).filter(ImageFilter.GaussianBlur(0.6))
im.save('audio/menu.jpg', quality=82)
