import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

MOCKUPS_DIR = 'video/assets/mockups'
DOODLES_DIR = 'video/assets/doodles'
os.makedirs(MOCKUPS_DIR, exist_ok=True)
os.makedirs(DOODLES_DIR, exist_ok=True)

# Vietnamese-safe fonts
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 38)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 24)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 48)

def draw_wobbly_line(draw, points, fill='#101216', width=5):
    for i in range(len(points) - 1):
        x1, y1 = points[i]
        x2, y2 = points[i + 1]
        draw.line([(x1, y1), (x2, y2)], fill=fill, width=width)

# 1. Doodle Phone Mockups (Framing the real screenshots)
def create_doodle_phone_mockups():
    img1_path = 'video/18a4c767-e2d8-4b49-8051-09dde367df50.jpg'
    img2_path = 'video/b8830d61-2028-474e-8ffb-d4d68d87fe86.jpg'

    screen_w, screen_h = 462, 1000
    phone_w, phone_h = 520, 1080

    for idx, path in enumerate([img1_path, img2_path], start=1):
        if not os.path.exists(path):
            continue
        screen_img = Image.open(path).convert('RGBA')

        phone = Image.new('RGBA', (phone_w, phone_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(phone)

        # Phone body
        body_box = (10, 10, phone_w - 10, phone_h - 10)
        draw.rounded_rectangle(body_box, radius=42, fill='#181c24', outline='#0a0c10', width=8)
        draw.rounded_rectangle((16, 16, phone_w - 16, phone_h - 16), radius=38, outline='#3b4252', width=3)

        # Dynamic Island / Speaker notch
        notch_w, notch_h = 130, 28
        notch_x = (phone_w - notch_w) // 2
        draw.rounded_rectangle((notch_x, 24, notch_x + notch_w, 24 + notch_h), radius=14, fill='#0a0c10')
        draw.ellipse((notch_x + 95, 31, notch_x + 109, 45), fill='#232a38')

        # Paste real screenshot with rounded mask
        mask = Image.new('L', (screen_w, screen_h), 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.rounded_rectangle((0, 0, screen_w, screen_h), radius=28, fill=255)

        screen_x = (phone_w - screen_w) // 2
        screen_y = 52
        phone.paste(screen_img, (screen_x, screen_y), mask)

        # Doodle screen border
        draw.rounded_rectangle((screen_x - 2, screen_y - 2, screen_x + screen_w + 2, screen_y + screen_h + 2),
                               radius=30, outline='#2e3440', width=4)

        # Home indicator
        bar_w, bar_h = 140, 5
        bar_x = (phone_w - bar_w) // 2
        draw.rounded_rectangle((bar_x, phone_h - 22, bar_x + bar_w, phone_h - 22 + bar_h), radius=3, fill='#e5e9f0')

        out_name = f'mockup_phone_{idx}.png'
        phone.save(os.path.join(MOCKUPS_DIR, out_name))
        print(f"Created Doodle Phone Mockup: {out_name}")

# 2. Tra Da Sidewalk Scene
def create_tra_da_scene():
    tra_da = Image.new('RGBA', (700, 550), (0, 0, 0, 0))
    d = ImageDraw.Draw(tra_da)

    # Plastic blue stool (Ghế nhựa)
    d.rounded_rectangle((80, 280, 360, 335), radius=14, fill='#0284c7', outline='#0f172a', width=6)
    # Stool vent holes
    d.ellipse((170, 298, 195, 318), fill='#0369a1')
    d.ellipse((210, 298, 235, 318), fill='#0369a1')
    d.ellipse((250, 298, 275, 318), fill='#0369a1')
    # Stool legs
    d.line([(100, 335), (70, 500)], fill='#0f172a', width=8)
    d.line([(140, 335), (120, 485)], fill='#0f172a', width=7)
    d.line([(300, 335), (320, 485)], fill='#0f172a', width=7)
    d.line([(340, 335), (370, 500)], fill='#0f172a', width=8)
    d.line([(85, 420), (355, 420)], fill='#0284c7', width=7)

    # Glass of Iced Tea (Cốc trà đá vỉa hè)
    glass_pts = [(420, 180), (540, 180), (515, 380), (445, 380)]
    d.polygon(glass_pts, fill='#fef08a', outline='#0f172a')
    d.line([(420, 180), (540, 180), (515, 380), (445, 380), (420, 180)], fill='#0f172a', width=6)
    # Tea liquid
    liquid_pts = [(427, 235), (533, 235), (513, 375), (447, 375)]
    d.polygon(liquid_pts, fill='#d97706')
    # Ice cubes
    d.rectangle((450, 250, 490, 290), fill='#fef9c3', outline='#0f172a', width=4)
    d.rectangle((485, 270, 520, 310), fill='#fef9c3', outline='#0f172a', width=4)
    d.rectangle((460, 305, 500, 345), fill='#fef9c3', outline='#0f172a', width=4)
    # Straw
    d.line([(495, 120), (470, 360)], fill='#ef4444', width=9)
    # Lemon slice
    d.pieslice((400, 150, 455, 205), start=30, end=300, fill='#facc15', outline='#0f172a', width=5)

    # Sunflower seed plate (Đĩa hướng dương)
    d.ellipse((400, 390, 570, 460), fill='#e2e8f0', outline='#0f172a', width=5)
    for sx, sy in [(430, 415), (455, 408), (480, 412), (510, 407), (530, 420), (460, 428), (490, 425)]:
        d.ellipse((sx, sy, sx+14, sy+8), fill='#334155')

    tra_da.save(os.path.join(DOODLES_DIR, 'tra_da_scene.png'))
    print("Created tra_da_scene.png")

# 3. Robot Stressed Asset
def create_robot_asset():
    robot = Image.new('RGBA', (500, 500), (0, 0, 0, 0))
    d = ImageDraw.Draw(robot)

    # Robot Head
    d.rounded_rectangle((150, 90, 350, 240), radius=22, fill='#94a3b8', outline='#0f172a', width=7)
    # Antenna
    d.line([(250, 90), (250, 40)], fill='#0f172a', width=7)
    d.ellipse((236, 26, 264, 54), fill='#ef4444', outline='#0f172a', width=5)
    # Face screen
    d.rounded_rectangle((175, 115, 325, 215), radius=14, fill='#0f172a')
    # Glowing Stressed Eyes
    d.ellipse((195, 140, 235, 180), fill='#38bdf8')
    d.ellipse((265, 140, 305, 180), fill='#38bdf8')
    # Mouth
    d.line([(215, 195), (235, 185), (250, 195), (265, 185), (285, 195)], fill='#f43f5e', width=5)
    # Sweat drop
    d.ellipse((330, 105, 350, 130), fill='#38bdf8', outline='#0f172a', width=3)
    # Smoke puffs
    for px, py, r in [(100, 70, 28), (125, 45, 32), (360, 65, 30), (390, 40, 35)]:
        d.ellipse((px, py, px+r, py+r), fill='#f1f5f9', outline='#64748b', width=4)

    # Robot Body
    d.rounded_rectangle((175, 245, 325, 385), radius=18, fill='#cbd5e1', outline='#0f172a', width=7)
    # Meter on chest
    d.rounded_rectangle((195, 270, 305, 325), radius=10, fill='#0284c7', outline='#0f172a', width=4)
    d.text((210, 282), "126K", fill='#ffffff', font=FONT_BOLD)
    # Arms
    d.line([(175, 290), (115, 340), (155, 390)], fill='#0f172a', width=9)
    d.line([(325, 290), (385, 340), (345, 390)], fill='#0f172a', width=9)
    # Keyboard
    d.rounded_rectangle((110, 390, 390, 445), radius=10, fill='#334155', outline='#0f172a', width=6)
    # Speed typing lines
    for lx in range(130, 380, 25):
        d.line([(lx, 380), (lx, 362)], fill='#f59e0b', width=4)

    robot.save(os.path.join(DOODLES_DIR, 'robot_stress.png'))
    print("Created robot_stress.png")

# 4. Multi-Device Setup (Home-PC + Laptop + VPS + Remote Hub)
def create_multi_devices():
    devices = Image.new('RGBA', (840, 480), (0, 0, 0, 0))
    d = ImageDraw.Draw(devices)

    # CRT Home-PC
    d.rounded_rectangle((30, 90, 230, 250), radius=16, fill='#e2e8f0', outline='#0f172a', width=6)
    d.rounded_rectangle((50, 110, 210, 230), radius=10, fill='#0f172a')
    d.text((70, 150), "Home-PC", fill='#22c55e', font=FONT_BOLD)
    d.polygon([(100, 250), (160, 250), (180, 280), (80, 280)], fill='#cbd5e1', outline='#0f172a')
    # Spiderweb
    d.line([(30, 90), (80, 130)], fill='#94a3b8', width=3)
    # Tower
    d.rounded_rectangle((240, 130, 320, 310), radius=8, fill='#94a3b8', outline='#0f172a', width=6)
    d.line([(255, 160), (305, 160)], fill='#0f172a', width=4)
    d.ellipse((270, 260, 290, 280), fill='#22c55e', outline='#0f172a', width=4) # Power ON!

    # Laptop
    d.rounded_rectangle((350, 150, 520, 275), radius=10, fill='#334155', outline='#0f172a', width=6)
    d.rounded_rectangle((365, 165, 505, 260), radius=6, fill='#0284c7')
    d.text((395, 195), "Laptop", fill='#ffffff', font=FONT_BOLD)
    d.polygon([(330, 275), (540, 275), (560, 305), (310, 305)], fill='#64748b', outline='#0f172a')

    # VPS Cloud
    d.rounded_rectangle((580, 80, 800, 190), radius=40, fill='#dbeafe', outline='#0f172a', width=6)
    d.text((615, 115), "VPS Cloud", fill='#1e40af', font=FONT_BOLD)

    # Connecting cables
    draw_wobbly_line(d, [(210, 280), (280, 375), (420, 375)], fill='#0066FF', width=7)
    draw_wobbly_line(d, [(435, 305), (435, 375)], fill='#0066FF', width=7)
    draw_wobbly_line(d, [(690, 190), (690, 340), (450, 375)], fill='#0066FF', width=7)

    # Wide Central Remote Tab Hub
    hub_box = (290, 370, 590, 440)
    d.rounded_rectangle(hub_box, radius=16, fill='#0066FF', outline='#0f172a', width=6)
    d.text((315, 385), "CHUYỂN MÁY 1 TAB", fill='#ffffff', font=FONT_BOLD)

    devices.save(os.path.join(DOODLES_DIR, 'multi_devices.png'))
    print("Created multi_devices.png")

# 5. Exam Sheet (Proper Vietnamese Font)
def create_exam_sheet():
    exam = Image.new('RGBA', (620, 720), (0, 0, 0, 0))
    d = ImageDraw.Draw(exam)

    # Sheet
    d.rectangle((30, 20, 590, 680), fill='#ffffff', outline='#0f172a', width=7)
    # Header
    d.text((70, 45), "BÀI THI TRẮC NGHIỆM HITL", fill='#0f172a', font=FONT_TITLE)
    d.line([(50, 100), (570, 100)], fill='#cbd5e1', width=4)

    questions = [
        "Câu 1: Duyệt quyền chạy script?",
        "Câu 2: Chấp nhận sửa file config?",
        "Câu 3: Chạy lệnh git commit?",
        "Câu 4: Đồng ý migrate database?",
        "Câu 5: Cho phép xoá thư mục temp?"
    ]
    options_y = [125, 205, 285, 365, 445]
    checked_opts = [0, 0, 0, 0, 0] # All picked A ("Recommend"!)

    for q_idx, (y, q_text) in enumerate(zip(options_y, questions), start=1):
        d.text((60, y), q_text, fill='#334155', font=FONT_REGULAR)
        for opt_idx, letter in enumerate(['A', 'B', 'C', 'D']):
            ox = 150 + opt_idx * 95
            oy = y + 36
            d.ellipse((ox, oy, ox + 36, oy + 36), fill='#f8fafc', outline='#0f172a', width=4)
            d.text((ox + 9, oy + 4), letter, fill='#0f172a', font=FONT_BOLD)

            # Vigorous pencil fill on (A)
            if opt_idx == checked_opts[q_idx - 1]:
                d.ellipse((ox + 5, oy + 5, ox + 31, oy + 31), fill='#0f172a')
                # Red checkmark
                d.line([(ox + 35, oy + 10), (ox + 46, oy + 34), (ox + 68, oy - 6)], fill='#ef4444', width=6)

    # Evaluation Box Placeholder (Waiting for stamp)
    d.rounded_rectangle((60, 530, 560, 640), radius=14, fill='#f8fafc', outline='#cbd5e1', width=3)
    d.text((150, 570), "[ KHU VỰC CHẤM ĐIỂM ]", fill='#94a3b8', font=FONT_BOLD)

    exam.save(os.path.join(DOODLES_DIR, 'exam_sheet.png'))
    print("Created exam_sheet.png")

# 6. Doodle Badges & Banners
def create_badges():
    # A. NGHỊCH LÝ AI Banner
    b1 = Image.new('RGBA', (600, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(b1)
    d.rounded_rectangle((10, 10, 590, 110), radius=18, fill='#fef08a', outline='#0f172a', width=6)
    d.text((65, 30), "NGHỊCH LÝ AI AGENT", fill='#0f172a', font=FONT_TITLE)
    b1.save(os.path.join(DOODLES_DIR, 'badge_nghich_ly.png'))

    # B. HITL Alert Banner
    b2 = Image.new('RGBA', (620, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(b2)
    d.rounded_rectangle((10, 10, 610, 110), radius=18, fill='#fee2e2', outline='#ef4444', width=6)
    d.text((35, 30), "HITL: HUMAN-IN-THE-LOOP", fill='#b91c1c', font=FONT_TITLE)
    b2.save(os.path.join(DOODLES_DIR, 'badge_hitl.png'))

    # C. Phân Mảnh Não Bộ
    b3 = Image.new('RGBA', (600, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(b3)
    d.rounded_rectangle((10, 10, 590, 110), radius=18, fill='#ffedd5', outline='#ea580c', width=6)
    d.text((80, 30), "CONTEXT BỊ PHÂN MẢNH!", fill='#c2410c', font=FONT_TITLE)
    b3.save(os.path.join(DOODLES_DIR, 'badge_phan_manh.png'))

    # D. RemoteCLI Logo Banner
    b4 = Image.new('RGBA', (600, 140), (0, 0, 0, 0))
    d = ImageDraw.Draw(b4)
    d.rounded_rectangle((10, 10, 590, 130), radius=22, fill='#0066FF', outline='#0f172a', width=6)
    d.text((120, 25), "RemoteCLI / Cloud CLI", fill='#ffffff', font=FONT_TITLE)
    d.text((115, 80), "Giao diện quản lý đa thiết bị", fill='#bfdbfe', font=FONT_SM)
    b4.save(os.path.join(DOODLES_DIR, 'badge_remotecli.png'))
    print("Created all badge banners")

if __name__ == '__main__':
    create_doodle_phone_mockups()
    create_tra_da_scene()
    create_robot_asset()
    create_multi_devices()
    create_exam_sheet()
    create_badges()
