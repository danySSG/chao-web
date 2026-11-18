# Второе синтетическое меню — ресторан морепродуктов: номера позиций, английские
# дубли названий, цена за кг в шапке раздела, «Thời giá», размеры и сноска про
# НДС и сервисный сбор. Ловит F65 (original), F32 (единицы цены) и F34 (состав).
# python3 make_menu2.py  →  audio/menu2.jpg
from PIL import Image, ImageDraw, ImageFont, ImageFilter
F = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
W, H = 1100, 1400
im = Image.new('RGB', (W, H), (247, 247, 240)); d = ImageDraw.Draw(im)
big, h2, f, sm = (ImageFont.truetype(F, s) for s in (60, 38, 30, 24))
d.text((W // 2, 70), "HẢI SẢN BÉ MẶN", font=big, fill=(20, 60, 120), anchor="mm")
d.text((W // 2, 128), "Võ Nguyên Giáp · Đà Nẵng · Seafood Restaurant", font=sm, fill=(70, 70, 90), anchor="mm")
menu = [("HẢI SẢN TƯƠI SỐNG / LIVE SEAFOOD — Giá/kg", [
            ("01. Tôm hùm nướng phô mai / Cheese grilled lobster", "1.200.000"),
            ("02. Cua rang me / Tamarind crab", "Thời giá"),
            ("03. Ốc hương xào bơ tỏi / Garlic butter sweet snails", "450.000")]),
        ("MÓN KHÁC / OTHERS", [
            ("04. Mực một nắng nướng / Grilled sun-dried squid", "350.000"),
            ("05. Cơm chiên hải sản / Seafood fried rice", "90.000")]),
        ("NƯỚC / DRINKS", [
            ("06. Nước mía (nhỏ / lớn) / Sugarcane juice (S / L)", "15.000 / 25.000"),
            ("07. Bia Larue", "20.000")])]
y = 200
for sec, items in menu:
    d.text((60, y), sec, font=h2, fill=(20, 60, 120)); y += 60
    for n, p in items:
        d.text((80, y), n, font=f, fill=(30, 30, 30)); y += 42
        d.text((W - 70, y), p if p == "Thời giá" else p + "đ", font=f, fill=(150, 30, 20), anchor="ra"); y += 52
    y += 20
d.text((W // 2, H - 70), "Giá chưa bao gồm VAT 8% và phí phục vụ 5% · Chỉ nhận tiền mặt", font=sm, fill=(90, 60, 40), anchor="mm")
im = im.rotate(-1.2, expand=False, fillcolor=(200, 200, 190)).filter(ImageFilter.GaussianBlur(0.5))
im.save('audio/menu2.jpg', quality=82)
