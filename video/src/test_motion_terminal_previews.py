import os
import sys
import math
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, 'video/src')
import terminal_ui as tui
import terminal_doodle_scenes as tds
from anim_scenes import draw_chibi_overloaded_dev

WIDTH = 1080
HEIGHT = 1920

# Fonts
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44)
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_SUBTITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)
FONT_CODE = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 22)
FONT_CODE_BOLD = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)

# Colors
BG_DARK = '#0f141c'
TERM_BG = '#090d16'
BORDER_DARK = '#1e293b'
TEXT_CYAN = '#38bdf8'
TEXT_GREEN = '#4ade80'
TEXT_YELLOW = '#facc15'
TEXT_RED = '#f87171'

# Real Mockups
MOCKUP_1 = Image.open('video/assets/mockups/mockup_phone_1.png').convert('RGBA')
MOCKUP_2 = Image.open('video/assets/mockups/mockup_phone_2.png').convert('RGBA')

MOCKUP_SCALE = 1.35
M_W = int(520 * MOCKUP_SCALE) # 702
M_H = int(1080 * MOCKUP_SCALE) # 1458
M_X = (WIDTH - M_W) // 2 # 189
M_Y = 60

SCALED_M1 = MOCKUP_1.resize((M_W, M_H), Image.Resampling.LANCZOS)
SCALED_M2 = MOCKUP_2.resize((M_W, M_H), Image.Resampling.LANCZOS)

def render_preview_scene(scene_num, t=2.5):
    im = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(im)

    if scene_num == 1:
        # === SCENE 1: Nghịch Lý AI & HITL ===
        tui.draw_mobile_header(draw, active_tab='Home-PC')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=0)

        # Terminal Window Box
        code_box = (35, 230, WIDTH - 35, 1420)
        draw.rounded_rectangle(code_box, radius=18, fill=TERM_BG, outline=BORDER_DARK, width=2)

        # Terminal Top Bar
        draw.rounded_rectangle((35, 230, WIDTH - 35, 290), radius=18, fill='#161e2e')
        draw.text((60, 245), ">_ PowerShell Terminal (HITL Active)", fill=TEXT_CYAN, font=FONT_BOLD)
        draw.ellipse((WIDTH - 70, 252, WIDTH - 52, 270), fill='#22c55e')

        # PowerShell Code Lines
        code_lines = [
            ("$tokenBudget = 1000000; # Max quota burn", '#4ade80'),
            ("while ($true) {", '#4ade80'),
            ("    $task = Invoke-ClaudeAgent -Loop dynamic", '#4ade80'),
            ("    if ($task.NeedsApproval) {", '#facc15'),
            ("        Wait-For-Human-In-The-Loop -Timeout Infinite", '#f87171'),
            ("    }", '#facc15'),
            ("}", '#4ade80')
        ]
        for idx, (cl, ccol) in enumerate(code_lines):
            draw.text((60, 315 + idx * 42), cl, fill=ccol, font=FONT_CODE_BOLD)

        # Left: Motion Graphics Robot with animated typing arms & glowing eyes
        tds.draw_dark_robot(draw, 320, 850, scale=1.35, t=t)

        # Right: Motion Graphics Stressed Dev with wild hair, sweat drops, knock knees, honeycomb slippers
        tds.draw_dark_dev(draw, 780, 870, scale=1.3, pose='standing_stressed', t=t)

        # Alert Banner
        banner_box = (80, 1180, WIDTH - 80, 1280)
        draw.rounded_rectangle(banner_box, radius=16, fill='#450a0a', outline='#ef4444', width=4)
        draw.text((120, 1205), "ĐỐT TOKEN NGÀY ĐÊM NHƯNG PHẢI CANH HITL!", fill='#fca5a5', font=FONT_BOLD)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 2:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        tui.draw_mobile_header(draw, active_tab='Home-PC')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=2)

        chat_box = (35, 230, WIDTH - 35, 1420)
        draw.rounded_rectangle(chat_box, radius=18, fill=TERM_BG, outline=BORDER_DARK, width=2)

        draw.text((60, 245), "💬 Remote Session • QuanTraDa_ViaHe.session", fill=TEXT_CYAN, font=FONT_BOLD)
        draw.line([(35, 290), (WIDTH - 35, 290)], fill=BORDER_DARK, width=2)

        # Chat Bubbles
        draw.rounded_rectangle((WIDTH - 580, 320, WIDTH - 60, 400), radius=16, fill='#172554', outline='#3b82f6', width=2)
        draw.text((WIDTH - 550, 340), "Ghé trà đá làm cốc đi anh em ơi!", fill='#93c5fd', font=FONT_SUBTITLE)

        draw.rounded_rectangle((60, 420, 640, 500), radius=16, fill='#1e293b', outline='#475569', width=2)
        draw.text((90, 440), "🤖 Claude: Em đang cày refactor xong 3 module rồi ạ!", fill='#4ade80', font=FONT_SM)

        draw.rounded_rectangle((WIDTH - 640, 520, WIDTH - 60, 600), radius=16, fill='#172554', outline='#3b82f6', width=2)
        draw.text((WIDTH - 610, 540), "Chat AI sướng như nhắn tin với ghệ!", fill=TEXT_CYAN, font=FONT_SUBTITLE)

        # Left: Motion Graphics Dev sitting on Duy Tân plastic stool, tapping phone, foot tapping ("nhịp giò")
        tds.draw_dark_dev(draw, 380, 940, scale=1.4, pose='sitting_tra_da', t=t)

        # Right: Street trà đá table with tall iced tea, lemon, red straw, rising vapor, sunflower seeds, beer crate
        tds.draw_dark_tra_da_table(draw, 780, 940, scale=1.35, t=t)

        # Punchline Badge
        punch_box = (80, 1260, WIDTH - 80, 1370)
        draw.rounded_rectangle(punch_box, radius=20, fill='#450a0a', outline='#ef4444', width=5)
        draw.text((120, 1290), "TỰ NHIÊN LẠI GÁNH THÊM VIỆC!", fill=TEXT_RED, font=FONT_HERO)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 3:
        # === SCENE 3: Hồi Sinh Máy Cũ & Chuyển Máy 1 Tab ===
        tui.draw_mobile_header(draw, active_tab='Laptop')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=3)

        term_box = (35, 230, WIDTH - 35, 1420)
        draw.rounded_rectangle(term_box, radius=18, fill=TERM_BG, outline=BORDER_DARK, width=2)

        # Tab Switching Ripple
        tab_box_lap = (348, 150, 489, 194)
        draw.rounded_rectangle(tab_box_lap, radius=12, outline=TEXT_YELLOW, width=4)
        draw.circle((418, 172), 28, outline=TEXT_CYAN, width=3)

        # Motion Graphics Multi-Device Ecosystem
        tds.draw_dark_ecosystem(draw, 540, 720, scale=1.25, t=t)

        # Highlight Sticker
        box = (80, 1180, WIDTH - 80, 1300)
        draw.rounded_rectangle(box, radius=20, fill='#172554', outline=TEXT_CYAN, width=6)
        draw.text((120, 1215), "CHUYỂN MÁY CHỈ BẰNG 1 CÁI TAB!", fill=TEXT_CYAN, font=FONT_HERO)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 4:
        # === SCENE 4: BÙNG NỔ 5-6 PROJECTS (REAL Screenshot 1) ===
        # Drop shadow behind real image
        draw.rounded_rectangle((M_X - 8, M_Y - 8, M_X + M_W + 8, M_Y + M_H + 8), radius=28, fill='#040711', outline='#1e293b', width=3)

        # Paste REAL Image 1 (completely untouched original user screenshot)
        im.paste(SCALED_M1, (M_X, M_Y), SCALED_M1)

        # UAV Card is at y = 705..765 on original 1080h image
        uav_y = int(M_Y + 705 * MOCKUP_SCALE)
        uav_h = int(60 * MOCKUP_SCALE)

        # Animated Red Target Bracket on UAV
        pulse_col = '#ef4444' if math.sin(t * 12) > 0 else '#facc15'
        draw.rounded_rectangle((M_X + 12, uav_y, M_X + M_W - 12, uav_y + uav_h), radius=10, outline=pulse_col, width=5)

        # Callout tag on UAV
        draw.text((M_X + 20, uav_y - 34), "===> [!] UAV: 47 SESSIONS! <===", fill=TEXT_YELLOW, font=FONT_BOLD)

        # Floating Motion Graphics Project explosion tags
        alert_tags = [
            ("OTA: 2 sess", 20, 420, TEXT_CYAN),
            ("OTA-ext: 4 sess", WIDTH - 220, 420, TEXT_YELLOW),
            ("sandbox: 2", 20, 560, TEXT_GREEN),
            ("HOT: 47 SESS", WIDTH - 220, 560, TEXT_RED),
        ]
        for at_text, at_x, at_y, at_col in alert_tags:
            tw = len(at_text) * 14 + 24
            draw.rounded_rectangle((at_x, at_y, at_x + tw, at_y + 44), radius=10, fill='#111827', outline=at_col, width=2)
            draw.text((at_x + 10, at_y + 8), at_text, fill=at_col, font=FONT_SM)

        # Laser scanner beam
        scan_y = int(M_Y + 280 + (t * 240) % 850)
        draw.line([(M_X + 10, scan_y), (M_X + M_W - 10, scan_y)], fill='#38bdf8', width=2)

        # Subtitle
        draw.rounded_rectangle((60, 1540, WIDTH - 60, 1680), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1590), "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 5:
        # === SCENE 5: PHÂN MẢNH CONTEXT & 90 TIN NHẮN (REAL Screenshot 2) ===
        draw.rounded_rectangle((M_X - 8, M_Y - 8, M_X + M_W + 8, M_Y + M_H + 8), radius=28, fill='#040711', outline='#1e293b', width=3)
        im.paste(SCALED_M2, (M_X, M_Y), SCALED_M2)

        # Rotating target reticle on 90 Unread Messages Badge (x = 176..215, y = 894..914)
        bx = int(M_X + 195 * MOCKUP_SCALE)
        by = int(M_Y + 904 * MOCKUP_SCALE)

        ret_r = 32 + int(math.sin(t * 14) * 4)
        draw.ellipse((bx - ret_r, by - 22, bx + ret_r, by + 22), outline='#ef4444', width=4)
        rot_angle = t * 6
        dx = int(math.cos(rot_angle) * 45)
        dy = int(math.sin(rot_angle) * 25)
        draw.line([(bx - dx, by - dy), (bx + dx, by + dy)], fill='#ef4444', width=3)
        draw.line([(bx + dy, by - dx), (bx - dy, by + dx)], fill='#ef4444', width=3)

        draw.text((bx - 75, by - 70), "🔥 90 TIN NHẮN! 🔥", fill=TEXT_RED, font=FONT_BOLD)

        # Motion Graphics Chibi Overloaded Dev with rotating spiral eyes & steam
        draw_chibi_overloaded_dev(draw, 100, 320, scale=1.1, t=t)

        # Anime Flurry Barrage Punching Recommend Button
        tds.draw_dark_flurry_recommend(draw, 540, 1340, scale=1.15, t=t)

        # Subtitle
        draw.rounded_rectangle((60, 1540, WIDTH - 60, 1680), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1590), "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 6:
        # === SCENE 6: Bài Thi Trắc Nghiệm & Cái Kết (ONLY RemoteCLI branding) ===
        tui.draw_mobile_header(draw, active_tab='Home-PC')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=90)

        # Terminal Exam Container
        tds.draw_dark_exam_terminal(draw, 540, 560, scale=1.1, t=t)

        # Rubber Stamp Slam
        stamp_box = (WIDTH - 420, 510, WIDTH - 80, 590)
        draw.rounded_rectangle(stamp_box, radius=12, outline='#ef4444', width=5)
        draw.text((WIDTH - 400, 530), "APPROVED - HITL", fill='#ef4444', font=FONT_BOLD)

        # Slumped Dev on floor with cute soul ghost
        tds.draw_dark_slumped_dev(draw, 540, 1060, scale=1.25, t=t)

        # Card: BẬN HƠN CẢ KHI CHƯA CÓ AI!
        stamp_box = (80, 1260, WIDTH - 80, 1370)
        draw.rounded_rectangle(stamp_box, radius=18, fill='#450a0a', outline='#ef4444', width=5)
        draw.text((130, 1285), "BẬN HƠN CẢ KHI CHƯA CÓ AI!", fill='#fca5a5', font=FONT_HERO)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Bạn còn bận hơn cả lúc chưa có AI!", fill='#ffffff', font=FONT_TITLE)

    out_file = f'video/preview_motion_term_{scene_num}.png'
    im.save(out_file)
    print(f"Generated {out_file}")

def render_preview_outro():
    # Outro Card with ONLY RemoteCLI name and NO extra links
    im = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(im)

    tui.draw_mobile_header(draw, active_tab='Home-PC')
    tui.draw_mobile_footer(draw, tokens='126K', unread_count=0)

    # Final Outro Card
    card_box = (80, 480, WIDTH - 80, 940)
    draw.rounded_rectangle(card_box, radius=24, fill='#111827', outline='#0066FF', width=6)
    draw.text((130, 520), "RemoteCLI", fill=TEXT_CYAN, font=FONT_HERO)

    draw.text((115, 620), "BẬN HƠN CẢ KHI CHƯA CÓ AI!", fill='#f87171', font=FONT_HERO)
    draw.text((115, 710), "Giải phóng chiếc máy tính của bạn,", fill='#ffffff', font=FONT_TITLE)
    draw.text((115, 770), "nhưng đừng để AI quản lý lại bạn!", fill=TEXT_CYAN, font=FONT_TITLE)

    # Sitting Dev enjoying trà đá peacefully
    tds.draw_dark_dev(draw, 380, 1140, scale=1.3, pose='sitting_tra_da', t=2.0)
    tds.draw_dark_tra_da_table(draw, 750, 1140, scale=1.25, t=2.0)

    out_file = 'video/preview_motion_term_outro.png'
    im.save(out_file)
    print(f"Generated {out_file}")

if __name__ == '__main__':
    for s in range(1, 7):
        render_preview_scene(s)
    render_preview_outro()
