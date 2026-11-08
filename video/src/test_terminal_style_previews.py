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

# Monospace Terminal Fonts (Consolas)
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 38)
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 30)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)
FONT_SUBTITLE = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 22)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 22)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 20)
FONT_XS = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 16)

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

def draw_terminal_subtitle(draw, text, keyword="", y=1450):
    """
    Renders terminal-styled subtitle prompt box:
    > [KEYWORD] Subtitle text here...
    """
    box = (50, y, WIDTH - 50, y + 110)
    draw.rectangle(box, fill='#090d16', outline='#38bdf8', width=2)
    # Terminal accent header line
    draw.rectangle((50, y, 70, y + 110), fill='#1e293b')
    draw.text((55, y + 38), ">", fill='#38bdf8', font=FONT_BOLD)

    if keyword:
        kw_str = f"[{keyword}] "
        draw.text((85, y + 20), kw_str, fill='#facc15', font=FONT_BOLD)
        bbox = draw.textbbox((0, 0), kw_str, font=FONT_BOLD)
        kw_w = bbox[2] - bbox[0]
        draw.text((85 + kw_w, y + 20), text, fill='#ffffff', font=FONT_BOLD)
    else:
        draw.text((85, y + 38), text, fill='#ffffff', font=FONT_TITLE)

def render_preview_scene(scene_num, t=2.5):
    im = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(im)

    if scene_num == 1:
        # === SCENE 1: Nghịch Lý AI & HITL ===
        tui.draw_mobile_header(draw, active_tab='Home-PC', url='vibexai.net')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=0)

        # Terminal Window Box (Sharp Terminal Edges)
        code_box = (35, 230, WIDTH - 35, 1420)
        draw.rectangle(code_box, fill=TERM_BG, outline=BORDER_DARK, width=2)

        # Terminal Header Bar
        draw.rectangle((35, 230, WIDTH - 35, 290), fill='#161e2e')
        draw.text((60, 248), ">_ PowerShell Terminal (HITL Supervisor Active)", fill=TEXT_CYAN, font=FONT_BOLD)
        draw.rectangle((WIDTH - 75, 252, WIDTH - 55, 272), fill='#22c55e')

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
            draw.text((60, 315 + idx * 40), cl, fill=ccol, font=FONT_BOLD)

        # DOODLE ONLY: AI Robot & Stressed Dev
        tds.draw_dark_robot(draw, 320, 850, scale=1.35, t=t)
        tds.draw_dark_dev(draw, 780, 870, scale=1.3, pose='standing_stressed', t=t)

        # Terminal Alert Box (Sharp, Monospace)
        banner_box = (60, 1180, WIDTH - 60, 1280)
        draw.rectangle(banner_box, fill='#450a0a', outline='#ef4444', width=3)
        draw.text((80, 1208), "[!] ĐỐT TOKEN NGÀY ĐÊM NHƯNG PHẢI CANH HITL! [!]", fill='#fca5a5', font=FONT_TITLE)

        # Subtitle
        draw_terminal_subtitle(draw, "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", keyword="HITL", y=1450)

    elif scene_num == 2:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        tui.draw_mobile_header(draw, active_tab='Home-PC', url='vibexai.net')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=2)

        chat_box = (35, 230, WIDTH - 35, 1420)
        draw.rectangle(chat_box, fill=TERM_BG, outline=BORDER_DARK, width=2)

        draw.rectangle((35, 230, WIDTH - 35, 290), fill='#161e2e')
        draw.text((60, 248), ">_ Remote Session • QuanTraDa_ViaHe.session", fill=TEXT_CYAN, font=FONT_BOLD)
        draw.rectangle((WIDTH - 75, 252, WIDTH - 55, 272), fill='#22c55e')

        # Chat Bubbles formatted as Terminal Logs
        draw.rectangle((WIDTH - 640, 320, WIDTH - 60, 395), fill='#172554', outline='#3b82f6', width=2)
        draw.text((WIDTH - 620, 340), "[23:26] Dev: Ghé trà đá làm cốc đi anh em ơi!", fill='#93c5fd', font=FONT_SUBTITLE)

        draw.rectangle((60, 415, 780, 490), fill='#1e293b', outline='#475569', width=2)
        draw.text((80, 435), "[23:26] AI : Em đang refactor xong 3 module rồi ạ!", fill='#4ade80', font=FONT_SUBTITLE)

        draw.rectangle((WIDTH - 660, 510, WIDTH - 60, 585), fill='#172554', outline='#3b82f6', width=2)
        draw.text((WIDTH - 640, 530), "[23:27] Dev: Chat AI sướng như nhắn tin với ghệ!", fill=TEXT_CYAN, font=FONT_SUBTITLE)

        # DOODLE ONLY: Dev sitting on Duy Tân stool + Trà đá table
        tds.draw_dark_dev(draw, 380, 940, scale=1.4, pose='sitting_tra_da', t=t)
        tds.draw_dark_tra_da_table(draw, 780, 940, scale=1.35, t=t)

        # Terminal Alert Box
        punch_box = (60, 1260, WIDTH - 60, 1360)
        draw.rectangle(punch_box, fill='#450a0a', outline='#ef4444', width=3)
        draw.text((80, 1290), "[!] ĐANG YÊN ĐANG LÀNH TỰ NHIÊN GÁNH THÊM VIỆC! [!]", fill=TEXT_RED, font=FONT_HERO)

        # Subtitle
        draw_terminal_subtitle(draw, "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", keyword="TRÀ ĐÁ VỈA HÈ", y=1450)

    elif scene_num == 3:
        # === SCENE 3: Hồi Sinh Máy Cũ & Chuyển Máy 1 Tab ===
        tui.draw_mobile_header(draw, active_tab='Laptop', url='vibexai.net')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=3)

        term_box = (35, 230, WIDTH - 35, 1420)
        draw.rectangle(term_box, fill=TERM_BG, outline=BORDER_DARK, width=2)

        # Tab Switching Focus
        tab_box_lap = (348, 150, 489, 194)
        draw.rectangle(tab_box_lap, outline=TEXT_YELLOW, width=3)

        # DOODLE ONLY: Ecosystem CRT PC, Laptop, Cloud VPS, Data Cables
        tds.draw_dark_ecosystem(draw, 540, 720, scale=1.25, t=t)

        # Terminal Highlight Box
        box = (60, 1180, WIDTH - 60, 1280)
        draw.rectangle(box, fill='#172554', outline=TEXT_CYAN, width=3)
        draw.text((100, 1210), ">> CHUYỂN MÁY CHỈ BẰNG 1 CÁI TAB! <<", fill=TEXT_CYAN, font=FONT_HERO)

        # Subtitle
        draw_terminal_subtitle(draw, "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", keyword="CHUYỂN MÁY 1 TAB", y=1450)

    elif scene_num == 4:
        # === SCENE 4: BÙNG NỔ 5-6 PROJECTS (REAL Screenshot 1) ===
        # Drop shadow behind real image
        draw.rectangle((M_X - 6, M_Y - 6, M_X + M_W + 6, M_Y + M_H + 6), fill='#040711', outline='#1e293b', width=2)

        # Paste REAL Image 1 (completely untouched original user screenshot)
        im.paste(SCALED_M1, (M_X, M_Y), SCALED_M1)

        # UAV Card is at y = 705..765 on original 1080h image
        uav_y = int(M_Y + 705 * MOCKUP_SCALE)
        uav_h = int(60 * MOCKUP_SCALE)

        # Terminal Target Bracket on UAV
        pulse_col = '#ef4444' if math.sin(t * 12) > 0 else '#facc15'
        draw.rectangle((M_X + 12, uav_y, M_X + M_W - 12, uav_y + uav_h), outline=pulse_col, width=4)

        # Callout tag on UAV in Consolas Bold
        draw.text((M_X + 20, uav_y - 32), "===> [!] UAV: 47 SESSIONS! <===", fill=TEXT_YELLOW, font=FONT_BOLD)

        # Terminal Project Chips on sides
        alert_tags = [
            ("[OTA: 2 sess]", 15, 420, TEXT_CYAN),
            ("[OTA-ext: 4 sess]", WIDTH - 225, 420, TEXT_YELLOW),
            ("[sandbox: 2]", 15, 560, TEXT_GREEN),
            ("[HOT: 47 SESS]", WIDTH - 225, 560, TEXT_RED),
        ]
        for at_text, at_x, at_y, at_col in alert_tags:
            bbox = draw.textbbox((0, 0), at_text, font=FONT_SUBTITLE)
            tw = bbox[2] - bbox[0] + 16
            draw.rectangle((at_x, at_y, at_x + tw, at_y + 38), fill='#090d16', outline=at_col, width=2)
            draw.text((at_x + 8, at_y + 6), at_text, fill=at_col, font=FONT_SUBTITLE)

        # Laser scanner beam
        scan_y = int(M_Y + 280 + (t * 240) % 850)
        draw.line([(M_X + 10, scan_y), (M_X + M_W - 10, scan_y)], fill='#38bdf8', width=2)

        # Subtitle
        draw_terminal_subtitle(draw, "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", keyword="5-6 PROJECTS", y=1540)

    elif scene_num == 5:
        # === SCENE 5: PHÂN MẢNH CONTEXT & 90 TIN NHẮN (REAL Screenshot 2) ===
        draw.rectangle((M_X - 6, M_Y - 6, M_X + M_W + 6, M_Y + M_H + 6), fill='#040711', outline='#1e293b', width=2)
        im.paste(SCALED_M2, (M_X, M_Y), SCALED_M2)

        # Rotating target reticle on 90 Unread Messages Badge (x = 176..215, y = 894..914)
        bx = int(M_X + 195 * MOCKUP_SCALE)
        by = int(M_Y + 904 * MOCKUP_SCALE)

        ret_r = 32 + int(math.sin(t * 14) * 4)
        draw.ellipse((bx - ret_r, by - 22, bx + ret_r, by + 22), outline='#ef4444', width=3)
        rot_angle = t * 6
        dx = int(math.cos(rot_angle) * 45)
        dy = int(math.sin(rot_angle) * 25)
        draw.line([(bx - dx, by - dy), (bx + dx, by + dy)], fill='#ef4444', width=2)
        draw.line([(bx + dy, by - dx), (bx - dy, by + dx)], fill='#ef4444', width=2)

        draw.text((bx - 85, by - 65), "[!] 90 TIN NHẮN! [!]", fill=TEXT_RED, font=FONT_BOLD)

        # DOODLE ONLY: Chibi Overloaded Dev
        draw_chibi_overloaded_dev(draw, 140, 320, scale=1.1, t=t)

        # Panic Terminal Chips
        panic_tags = [
            ("[Xin duyệt quyền?]", WIDTH - 245, 320, TEXT_YELLOW),
            ("[Git conflict!]", 15, 520, '#c084fc'),
            ("[47 SESSIONS!]", WIDTH - 225, 520, TEXT_RED),
        ]
        for pt_text, px, py, pc in panic_tags:
            bbox = draw.textbbox((0, 0), pt_text, font=FONT_SUBTITLE)
            tw = bbox[2] - bbox[0] + 16
            draw.rectangle((px, py, px + tw, py + 38), fill='#090d16', outline=pc, width=2)
            draw.text((px + 8, py + 6), pt_text, fill=pc, font=FONT_SUBTITLE)

        # DOODLE ONLY: Anime Flurry Barrage Punching Recommend
        tds.draw_dark_flurry_recommend(draw, 540, 1340, scale=1.15, t=t)

        # Subtitle
        draw_terminal_subtitle(draw, "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", keyword="BẤM RECOMMEND", y=1540)

    elif scene_num == 6:
        # === SCENE 6: Bài Thi Trắc Nghiệm & Cái Kết ===
        tui.draw_mobile_header(draw, active_tab='Home-PC', url='vibexai.net')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=90)

        # Terminal Exam Container
        tds.draw_dark_exam_terminal(draw, 540, 560, scale=1.1, t=t)

        # Rubber Stamp Slam
        stamp_box = (WIDTH - 420, 510, WIDTH - 60, 580)
        draw.rectangle(stamp_box, fill='#450a0a', outline='#ef4444', width=3)
        draw.text((WIDTH - 400, 526), "[ APPROVED - HITL ]", fill='#ef4444', font=FONT_BOLD)

        # DOODLE ONLY: Slumped Dev on floor with cute soul ghost
        tds.draw_dark_slumped_dev(draw, 540, 1060, scale=1.25, t=t)

        # Terminal Alert Box
        stamp_box = (60, 1260, WIDTH - 60, 1360)
        draw.rectangle(stamp_box, fill='#450a0a', outline='#ef4444', width=3)
        draw.text((80, 1290), "[!] BẬN HƠN CẢ KHI CHƯA CÓ AI! [!]", fill='#fca5a5', font=FONT_HERO)

        # Subtitle
        draw_terminal_subtitle(draw, "Bạn còn bận hơn cả lúc chưa có AI!", keyword="BẬN HƠN CHƯA CÓ AI", y=1450)

    out_file = f'video/preview_term_style_{scene_num}.png'
    im.save(out_file)
    print(f"Generated {out_file}")

def render_preview_outro():
    # Outro Card with ONLY RemoteCLI name and NO extra links, pure terminal style
    im = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(im)

    tui.draw_mobile_header(draw, active_tab='Home-PC', url='vibexai.net')
    tui.draw_mobile_footer(draw, tokens='126K', unread_count=0)

    # Pure Terminal Box Outro
    card_box = (60, 480, WIDTH - 60, 930)
    draw.rectangle(card_box, fill='#090d16', outline='#0066FF', width=3)

    # Top terminal bar
    draw.rectangle((60, 480, WIDTH - 60, 540), fill='#161e2e')
    draw.text((85, 495), ">_ RemoteCLI", fill=TEXT_CYAN, font=FONT_HERO)
    draw.rectangle((WIDTH - 100, 500, WIDTH - 80, 520), fill='#22c55e')

    draw.text((85, 600), "[!] BẬN HƠN CẢ KHI CHƯA CÓ AI!", fill='#f87171', font=FONT_HERO)
    draw.text((85, 690), "Giải phóng chiếc máy tính của bạn,", fill='#ffffff', font=FONT_TITLE)
    draw.text((85, 750), "nhưng đừng để AI quản lý lại bạn!", fill=TEXT_CYAN, font=FONT_TITLE)

    draw.line([(60, 830), (WIDTH - 60, 830)], fill=BORDER_DARK, width=2)
    draw.text((85, 860), "STATUS: REMOTE ZERO-LATENCY ACTIVE", fill=TEXT_GREEN, font=FONT_BOLD)

    # DOODLE ONLY: Sitting Dev enjoying trà đá peacefully
    tds.draw_dark_dev(draw, 380, 1140, scale=1.3, pose='sitting_tra_da', t=2.0)
    tds.draw_dark_tra_da_table(draw, 750, 1140, scale=1.25, t=2.0)

    out_file = 'video/preview_term_style_outro.png'
    im.save(out_file)
    print(f"Generated {out_file}")

if __name__ == '__main__':
    for s in range(1, 7):
        render_preview_scene(s)
    render_preview_outro()
