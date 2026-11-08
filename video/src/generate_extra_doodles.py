import os
import math
from PIL import Image, ImageDraw, ImageFont

DOODLES_DIR = 'video/assets/doodles'
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 32)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)

# 1. Dev sitting at Tra Da Stool with phone
def create_dev_tra_da():
    dev = Image.new('RGBA', (400, 500), (0, 0, 0, 0))
    d = ImageDraw.Draw(dev)

    # Head (Round doodle head with hair)
    d.ellipse((140, 60, 220, 140), fill='#ffedd5', outline='#0f172a', width=5)
    # Messy hair
    d.arc((135, 50, 225, 110), start=180, end=360, fill='#0f172a', width=6)
    d.line([(150, 60), (140, 40), (165, 55)], fill='#0f172a', width=5)
    d.line([(175, 55), (175, 35), (190, 52)], fill='#0f172a', width=5)
    # Face: smiling relaxed eyes (curved lines)
    d.arc((155, 90, 175, 105), start=0, end=180, fill='#0f172a', width=4)
    d.arc((185, 90, 205, 105), start=0, end=180, fill='#0f172a', width=4)
    # Smile
    d.arc((165, 110, 195, 125), start=0, end=180, fill='#0f172a', width=4)

    # Body (T-shirt)
    d.rounded_rectangle((145, 145, 215, 270), radius=14, fill='#38bdf8', outline='#0f172a', width=6)
    # Shorts
    d.rounded_rectangle((140, 265, 220, 340), radius=8, fill='#334155', outline='#0f172a', width=6)

    # Legs bent sitting down
    d.line([(160, 340), (140, 410), (160, 470)], fill='#0f172a', width=8)
    d.line([(200, 340), (220, 410), (240, 470)], fill='#0f172a', width=8)
    # Flip flops (Dép tổ ong)
    d.ellipse((140, 465, 180, 485), fill='#facc15', outline='#0f172a', width=4)
    d.ellipse((220, 465, 260, 485), fill='#facc15', outline='#0f172a', width=4)

    # Arms holding smartphone in front
    d.line([(145, 170), (110, 210), (150, 230)], fill='#0f172a', width=7)
    d.line([(215, 170), (240, 210), (190, 230)], fill='#0f172a', width=7)
    # Smartphone in hands
    d.rounded_rectangle((155, 205, 195, 265), radius=5, fill='#0284c7', outline='#0f172a', width=4)
    # Screen glow lines
    d.line([(175, 195), (175, 180)], fill='#38bdf8', width=3)
    d.line([(165, 198), (155, 185)], fill='#38bdf8', width=3)
    d.line([(185, 198), (195, 185)], fill='#38bdf8', width=3)

    dev.save(os.path.join(DOODLES_DIR, 'doodle_dev_tra_da.png'))
    print("Created doodle_dev_tra_da.png")

# 2. Rubber Stamp 10/10 HITL
def create_stamp():
    stamp = Image.new('RGBA', (500, 220), (0, 0, 0, 0))
    d = ImageDraw.Draw(stamp)

    # Slanted oval stamp border with solid white backing
    d.rounded_rectangle((15, 15, 485, 205), radius=28, fill='#ffffff', outline='#dc2626', width=8)
    d.rounded_rectangle((25, 25, 475, 195), radius=22, outline='#dc2626', width=3)

    # Text
    d.text((65, 45), "ĐẠT CHUẨN HITL", fill='#dc2626', font=FONT_TITLE)
    d.text((90, 100), "ĐIỂM: 10/10 (XUẤT SẮC)", fill='#b91c1c', font=FONT_TITLE)
    d.text((105, 155), "TOÀN CHỌN RECOMMEND", fill='#dc2626', font=FONT_SM)

    stamp.save(os.path.join(DOODLES_DIR, 'stamp_hitl_10.png'))
    print("Created stamp_hitl_10.png")

if __name__ == '__main__':
    create_dev_tra_da()
    create_stamp()
