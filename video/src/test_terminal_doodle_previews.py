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

FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44)
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_SUBTITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)
FONT_CODE = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 22)
FONT_CODE_BOLD = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)

def render_preview_scene(scene_num):
    im = Image.new('RGB', (WIDTH, HEIGHT), '#0f141c')
    draw = ImageDraw.Draw(im)

    if scene_num == 1:
        # === SCENE 1: Nghịch Lý AI & HITL Trong Terminal ===
        tui.draw_mobile_header(draw, active_tab='Home-PC')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=0)

        # Terminal Window Box
        code_box = (35, 230, WIDTH - 35, 1550)
        draw.rounded_rectangle(code_box, radius=18, fill='#090d16', outline='#1e293b', width=2)

        # Top Terminal Tab Bar
        draw.rounded_rectangle((35, 230, WIDTH - 35, 290), radius=18, fill='#161e2e')
        draw.text((60, 245), ">_ PowerShell Terminal (HITL Active)", fill='#38bdf8', font=FONT_BOLD)
        draw.ellipse((WIDTH - 70, 252, WIDTH - 52, 270), fill='#22c55e')

        # Live Green Code Lines
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

        # Left: Frantic typing AI Robot
        tds.draw_dark_robot(draw, 320, 850, scale=1.35, t=2.5)

        # Right: Stressed Dev scratching head, monitoring HITL
        tds.draw_dark_dev(draw, 780, 870, scale=1.3, pose='standing_stressed', t=2.5)

        # Center Alert Banner floating on terminal
        banner_box = (80, 1180, WIDTH - 80, 1280)
        draw.rounded_rectangle(banner_box, radius=16, fill='#450a0a', outline='#ef4444', width=4)
        draw.text((120, 1205), "ĐỐT TOKEN NGÀY ĐÊM NHƯNG PHẢI CANH HITL!", fill='#fca5a5', font=FONT_BOLD)

        # Subtitle Card (cleanly floating above the mobile bottom bar)
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline='#38bdf8', width=3)
        draw.text((85, 1485), "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 2:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        tui.draw_mobile_header(draw, active_tab='Home-PC')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=2)

        # Terminal Chat Background
        chat_box = (35, 230, WIDTH - 35, 1550)
        draw.rounded_rectangle(chat_box, radius=18, fill='#090d16', outline='#1e293b', width=2)

        # Terminal Subheader
        draw.text((60, 245), "💬 Remote Session • QuanTraDa_ViaHe.session", fill='#38bdf8', font=FONT_BOLD)
        draw.line([(35, 290), (WIDTH - 35, 290)], fill='#1e293b', width=2)

        # Street Trà Đá Chat Bubbles
        # Bubble 1: Dev
        draw.rounded_rectangle((WIDTH - 580, 320, WIDTH - 60, 400), radius=16, fill='#172554', outline='#3b82f6', width=2)
        draw.text((WIDTH - 550, 340), "Ghé trà đá làm cốc đi anh em ơi!", fill='#93c5fd', font=FONT_SUBTITLE)

        # Bubble 2: AI reply
        draw.rounded_rectangle((60, 420, 620, 500), radius=16, fill='#1e293b', outline='#475569', width=2)
        draw.text((90, 440), "🤖 Claude: Em đang cày refactor xong 3 module rồi ạ!", fill='#4ade80', font=FONT_SM)

        # Bubble 3: Dev
        draw.rounded_rectangle((WIDTH - 640, 520, WIDTH - 60, 600), radius=16, fill='#172554', outline='#3b82f6', width=2)
        draw.text((WIDTH - 610, 540), "Chat AI sướng như nhắn tin với ghệ!", fill='#38bdf8', font=FONT_SUBTITLE)

        # Left: Dev sitting on low plastic stool, tapping phone, foot tapping ("nhịp giò")
        tds.draw_dark_dev(draw, 380, 940, scale=1.4, pose='sitting_tra_da', t=3.0)

        # Right: Authentic street trà đá table with iced tea, lemon, red straw, and sunflower seeds
        tds.draw_dark_tra_da_table(draw, 780, 940, scale=1.35, t=3.0)

        # Punchline Badge
        punch_box = (80, 1260, WIDTH - 80, 1370)
        draw.rounded_rectangle(punch_box, radius=20, fill='#450a0a', outline='#ef4444', width=5)
        draw.text((120, 1290), "TỰ NHIÊN LẠI GÁNH THÊM VIỆC!", fill='#f87171', font=FONT_HERO)

        # Subtitle Card
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline='#38bdf8', width=3)
        draw.text((85, 1485), "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 3:
        # === SCENE 3: Hồi Sinh Máy Cũ & Chuyển Máy 1 Tab ===
        # Header with active tabs
        tui.draw_mobile_header(draw, active_tab='Laptop')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=3)

        # Terminal Body
        term_box = (35, 230, WIDTH - 35, 1550)
        draw.rounded_rectangle(term_box, radius=18, fill='#090d16', outline='#1e293b', width=2)

        # Animated finger tapping between tabs at top!
        tab_box_lap = (348, 150, 489, 194)
        draw.rounded_rectangle(tab_box_lap, radius=12, outline='#facc15', width=4)

        # Animated ripple around active tab
        draw.circle((418, 172), 28, outline='#38bdf8', width=3)

        # Multi-Device Ecosystem Doodles inside the terminal!
        tds.draw_dark_ecosystem(draw, 540, 720, scale=1.25, t=2.0)

        # Big Highlight Sticker
        box = (80, 1180, WIDTH - 80, 1300)
        draw.rounded_rectangle(box, radius=20, fill='#172554', outline='#38bdf8', width=6)
        draw.text((120, 1215), "CHUYỂN MÁY CHỈ BẰNG 1 CÁI TAB!", fill='#38bdf8', font=FONT_HERO)

        # Subtitle Card
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline='#38bdf8', width=3)
        draw.text((85, 1485), "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 4:
        # === SCENE 4: Bùng Nổ Projects (5-6 Projects, 47 Sessions - Image 1 View) ===
        tui.draw_mobile_header(draw, active_tab='Home-PC')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=47)

        # Draw Native Projects List View matching Image 1
        tui.draw_projects_list_view(draw, top_y=220, bottom_y=1600)

        # Danger Alert highlighting UAV project (47 sessions)
        # UAV is at card_y = search_y + 85 + 4 * 116 = 300 + 75 + 85 + 464 = 924
        uav_box = (45, 915, WIDTH - 45, 1015)
        draw.rounded_rectangle(uav_box, radius=16, outline='#ef4444', width=6)

        # Danger Beacon & Flashing Label
        draw.rounded_rectangle((WIDTH - 420, 930, WIDTH - 60, 1000), radius=14, fill='#ef4444')
        draw.text((WIDTH - 400, 946), "HOT: 47 SESSIONS!", fill='#ffffff', font=FONT_BOLD)

        # Floating Project explosion tags
        alert_tags = [
            ("OTA: 2 sess", 60, 520, '#38bdf8'),
            ("OTA-ext: 4 sess", WIDTH - 280, 580, '#facc15'),
            ("teleclaw-sandbox", 60, 720, '#4ade80'),
            ("TỔNG CỘNG: 57 SESSIONS!", 180, 1260, '#ef4444'),
        ]
        for at_text, at_x, at_y, at_col in alert_tags:
            draw.rounded_rectangle((at_x, at_y, at_x + len(at_text) * 16 + 28, at_y + 54), radius=12, fill='#111827', outline=at_col, width=3)
            draw.text((at_x + 14, at_y + 12), at_text, fill=at_col, font=FONT_BOLD)

        # Subtitle Card
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline='#38bdf8', width=3)
        draw.text((85, 1485), "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 5:
        # === SCENE 5: Phân Mảnh Context & 90 Tin Nhắn (Image 2 Native View) ===
        tui.draw_mobile_header(draw, active_tab='Home-PC')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=90)

        # Draw Native Active PowerShell Terminal Chat View matching Image 2
        tui.draw_terminal_chat_view(draw, top_y=220, bottom_y=1600)

        # Target Reticle on 90 Unread Messages Badge at bottom
        reticle_x = 232
        reticle_y = 1708
        draw.ellipse((reticle_x - 30, reticle_y - 20, reticle_x + 30, reticle_y + 20), outline='#ef4444', width=4)
        draw.line([(reticle_x - 45, reticle_y), (reticle_x + 45, reticle_y)], fill='#ef4444', width=3)
        draw.line([(reticle_x, reticle_y - 30), (reticle_x, reticle_y + 30)], fill='#ef4444', width=3)

        # Chibi Overloaded Dev with rotating spiral eyes & steam (Upper Right, single expressive rig)
        draw_chibi_overloaded_dev(draw, 880, 420, scale=1.2, t=4.5)

        # Floating Panic Tags across the code
        tags = [
            ("90 TIN NHẮN!", 45, 820, '#ef4444'),
            ("Xin duyệt quyền?", 45, 940, '#facc15'),
            ("Git conflict!", WIDTH - 270, 820, '#a855f7'),
            ("47 SESSIONS!", WIDTH - 270, 940, '#f87171'),
        ]
        for t_text, tx, ty, tc in tags:
            tw = len(t_text) * 16 + 28
            draw.rounded_rectangle((tx, ty, tx + tw, ty + 54), radius=12, fill='#111827', outline=tc, width=3)
            draw.text((tx + 14, ty + 12), t_text, fill=tc, font=FONT_BOLD)

        # Anime Flurry Barrage Punching Recommend Button
        tds.draw_dark_flurry_recommend(draw, 540, 1140, scale=1.2, t=4.5)

        # Warning Sticker
        draw.rounded_rectangle((80, 1330, WIDTH - 80, 1410), radius=16, fill='#450a0a', outline='#ef4444', width=4)
        draw.text((120, 1350), "TOÀN NHẮM MẮT BẤM RECOMMEND KHỎI NGHĨ!", fill='#fca5a5', font=FONT_BOLD)

        # Subtitle Card
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline='#38bdf8', width=3)
        draw.text((85, 1485), "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 6:
        # === SCENE 6: Bài Thi Trắc Nghiệm & Cái Kết ===
        tui.draw_mobile_header(draw, active_tab='Home-PC')
        tui.draw_mobile_footer(draw, tokens='126K', unread_count=90)

        # Native Terminal Exam Container
        tds.draw_dark_exam_terminal(draw, 540, 560, scale=1.1, t=3.5)

        # Big Rubber Stamp APPROVED - HITL slammed down onto option C
        stamp_box = (WIDTH - 420, 510, WIDTH - 80, 590)
        draw.rounded_rectangle(stamp_box, radius=12, outline='#ef4444', width=5)
        draw.text((WIDTH - 400, 530), "APPROVED - HITL", fill='#ef4444', font=FONT_BOLD)

        # Slumped Dev on ground
        tds.draw_dark_slumped_dev(draw, 540, 1060, scale=1.25, t=3.5)

        # Final Card: BẬN HƠN CẢ KHI CHƯA CÓ AI!
        stamp_box = (80, 1260, WIDTH - 80, 1370)
        draw.rounded_rectangle(stamp_box, radius=18, fill='#450a0a', outline='#ef4444', width=5)
        draw.text((130, 1285), "BẬN HƠN CẢ KHI CHƯA CÓ AI!", fill='#fca5a5', font=FONT_HERO)

        # Subtitle Card
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline='#38bdf8', width=3)
        draw.text((85, 1485), "Bạn còn bận hơn cả lúc chưa có AI!", fill='#ffffff', font=FONT_TITLE)

    out_file = f'video/preview_terminal_scene_{scene_num}.png'
    im.save(out_file)
    print(f"Generated {out_file}")

if __name__ == '__main__':
    for s in range(1, 7):
        render_preview_scene(s)
