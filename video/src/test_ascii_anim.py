import os
import sys
import math
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, 'video/src')
import ascii_anim_engine as aae

WIDTH = 1080
HEIGHT = 1920

# Fonts (Consolas Monospace)
FONT_ASCII_HERO = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 32)
FONT_ASCII = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 26)
FONT_ASCII_SM = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 20)
FONT_ASCII_XS = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 16)

FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 34)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)

# Colors
BG_DARK = '#090d16'
TEXT_WHITE = '#f8fafc'
TEXT_GREEN = '#4ade80'
TEXT_CYAN = '#38bdf8'
TEXT_YELLOW = '#facc15'
TEXT_RED = '#f87171'
TEXT_PURPLE = '#c084fc'

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

def draw_ascii_lines(draw, lines, x, y, font=FONT_ASCII, color=TEXT_WHITE, line_height=32):
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_height), line, fill=color, font=font)

def render_anim_test_frame(scene_num, t=2.5):
    im = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(im)

    if scene_num not in (4, 5):
        top_bar = [
            "+======================================================+",
            "| >_ RemoteCLI Terminal • Host: [Home-PC] • Ping: 12ms |",
            "+======================================================+",
        ]
        draw_ascii_lines(draw, top_bar, 60, 40, font=FONT_ASCII, color=TEXT_CYAN, line_height=30)

    if scene_num == 1:
        # === SCENE 1: Nghịch Lý AI & HITL ===
        pws_box = [
            ".------------------------------------------------------.",
            "| >_ Windows PowerShell (HITL Supervisor Active)       |",
            "'------------------------------------------------------'",
        ]
        draw_ascii_lines(draw, pws_box, 60, 130, font=FONT_ASCII, color=TEXT_CYAN, line_height=28)

        code_lines = [
            "$tokenBudget = 1000000; # Max quota burn",
            "while ($true) {",
            "    $agent = Invoke-ClaudeAgent -Loop Dynamic",
            "    if ($agent.NeedsApproval) {",
            "        Wait-For-Human-In-The-Loop -Timeout Infinite # Canh AI!",
            "    }",
            "}"
        ]
        draw_ascii_lines(draw, code_lines, 80, 225, font=FONT_ASCII_SM, color=TEXT_GREEN, line_height=30)

        # Animated Robot
        robot_lines = aae.get_animated_robot(t)
        draw_ascii_lines(draw, robot_lines, 40, 470, font=FONT_ASCII, color=TEXT_GREEN, line_height=34)

        # Animated Stressed Dev
        dev_lines = aae.get_animated_stressed_dev(t)
        draw_ascii_lines(draw, dev_lines, 540, 470, font=FONT_ASCII, color=TEXT_RED, line_height=34)

        # Warning Banners
        b1 = [
            "+======================================================+",
            "| [!] ĐỐT TOKEN NGÀY ĐÊM CHO ĐỠ PHÍ QUOTA!             |",
            "+======================================================+",
            "| [!] CHUẨN HITL: PHẢI NGỒI CANH TỪNG LI TỪNG TÝ!      |",
            "+======================================================+",
        ]
        draw_ascii_lines(draw, b1, 60, 1060, font=FONT_ASCII, color=TEXT_YELLOW, line_height=38)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 2:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        chat_box = [
            "+------------------------------------------------------+",
            "| [23:26] Dev:    Ghé trà đá làm cốc đi anh em ơi!     |",
            "| [23:26] Claude: Dạ em refactor xong 3 module rồi ạ!  |",
            "| [23:27] Dev:    Chat AI sướng như nhắn tin với ghệ!  |",
            "+------------------------------------------------------+",
        ]
        draw_ascii_lines(draw, chat_box, 60, 130, font=FONT_ASCII, color=TEXT_CYAN, line_height=32)

        # Animated Trà Đá Dev
        dev_trada = aae.get_animated_tra_da_dev(t)
        draw_ascii_lines(draw, dev_trada, 40, 480, font=FONT_ASCII, color=TEXT_CYAN, line_height=34)

        # Animated Trà Đá Table
        table_trada = aae.get_animated_tra_da_table(t)
        draw_ascii_lines(draw, table_trada, 500, 480, font=FONT_ASCII, color=TEXT_YELLOW, line_height=34)

        punch_ascii = [
            "+======================================================+",
            "| [!] ĐANG YÊN ĐANG LÀNH TỰ NHIÊN GÁNH THÊM VIỆC!      |",
            "+======================================================+",
        ]
        draw_ascii_lines(draw, punch_ascii, 60, 1060, font=FONT_ASCII, color=TEXT_RED, line_height=38)

        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 3:
        # === SCENE 3: Hồi Sinh Máy Cũ & Chuyển Máy 1 Tab ===
        active_tab_str = "[LAPTOP]" if int(t * 2) % 2 == 0 else "[HOME-PC]"
        tab_switcher = [
            "+------------------------------------------------------+",
            f"| TABS: [Local]  ==> {active_tab_str} <==  [Cloud-VPS]  [PC-Lab]  |",
            "+------------------------------------------------------+",
        ]
        draw_ascii_lines(draw, tab_switcher, 60, 130, font=FONT_ASCII, color=TEXT_YELLOW, line_height=32)

        ecosystem_lines = aae.get_animated_ecosystem(t)
        draw_ascii_lines(draw, ecosystem_lines, 60, 360, font=FONT_ASCII, color=TEXT_CYAN, line_height=34)

        banner_3 = [
            "+======================================================+",
            "| * ZERO-LATENCY MULTI-DEVICE TERMINAL MANAGER *       |",
            "+======================================================+",
        ]
        draw_ascii_lines(draw, banner_3, 60, 1060, font=FONT_ASCII, color=TEXT_GREEN, line_height=38)

        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 4:
        # === SCENE 4: BÙNG NỔ 5-6 PROJECTS (REAL Screenshot 1) ===
        # Drop shadow behind real image
        draw.rounded_rectangle((M_X - 8, M_Y - 8, M_X + M_W + 8, M_Y + M_H + 8), radius=28, fill='#040711', outline='#1e293b', width=3)

        # Paste REAL Image 1
        im.paste(SCALED_M1, (M_X, M_Y), SCALED_M1)

        # UAV Card is at y = 705..765 on original 1080h image
        uav_y = int(M_Y + 705 * MOCKUP_SCALE)
        uav_h = int(60 * MOCKUP_SCALE)

        # Animated Red Target Bracket on UAV
        pulse_col = '#ef4444' if math.sin(t * 12) > 0 else '#facc15'
        draw.rounded_rectangle((M_X + 12, uav_y, M_X + M_W - 12, uav_y + uav_h), radius=10, outline=pulse_col, width=5)

        # Callout tag on UAV
        draw.text((M_X + 20, uav_y - 34), "===> [!] UAV: 47 SESSIONS! <===", fill=TEXT_YELLOW, font=FONT_ASCII_SM)

        # Running dev on left side
        run_step = int(t * 8) % 2
        leg_l = "/ \\" if run_step == 0 else "| |"
        dev_run_left = [
            "  .---.",
            " (o_o;) [OTA]",
            " /| |\\",
            f"  {leg_l}  *run*",
        ]
        draw_ascii_lines(draw, dev_run_left, 10, 420, font=FONT_ASCII_XS, color=TEXT_CYAN, line_height=20)

        # Running dev on right side
        dev_run_right = [
            "  .---.",
            " (>_<;) [UAV]",
            " /| |\\",
            f"  {leg_l} *hot!*",
        ]
        draw_ascii_lines(draw, dev_run_right, WIDTH - 165, 420, font=FONT_ASCII_XS, color=TEXT_RED, line_height=20)

        # Animated laser scanner beam
        scan_y = int(M_Y + 280 + (t * 240) % 900)
        draw.line([(M_X + 10, scan_y), (M_X + M_W - 10, scan_y)], fill='#38bdf8', width=2)
        draw.text((M_X + 15, scan_y - 18), ">> SCANNING SESSIONS >>", fill=TEXT_CYAN, font=FONT_ASCII_XS)

        # Subtitle
        draw.rounded_rectangle((60, 1540, WIDTH - 60, 1680), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1590), "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 5:
        # === SCENE 5: PHÂN MẢNH CONTEXT & 90 TIN NHẮN (REAL Screenshot 2) ===
        draw.rounded_rectangle((M_X - 8, M_Y - 8, M_X + M_W + 8, M_Y + M_H + 8), radius=28, fill='#040711', outline='#1e293b', width=3)
        im.paste(SCALED_M2, (M_X, M_Y), SCALED_M2)

        # Target Reticle on 90 Unread Messages Badge (x = 176..215, y = 894..914)
        bx = int(M_X + 195 * MOCKUP_SCALE)
        by = int(M_Y + 904 * MOCKUP_SCALE)

        # Rotating crosshair reticle
        ret_r = 32 + int(math.sin(t * 14) * 4)
        draw.ellipse((bx - ret_r, by - 22, bx + ret_r, by + 22), outline='#ef4444', width=4)

        # Rotating tick marks
        rot_angle = t * 6
        dx = int(math.cos(rot_angle) * 45)
        dy = int(math.sin(rot_angle) * 25)
        draw.line([(bx - dx, by - dy), (bx + dx, by + dy)], fill='#ef4444', width=3)
        draw.line([(bx + dy, by - dx), (bx - dy, by + dx)], fill='#ef4444', width=3)

        draw.text((bx - 70, by - 70), "[ 90 TIN NHẮN! ]", fill=TEXT_RED, font=FONT_ASCII_SM)

        # Chibi Panic Dev
        chibi_lines = aae.get_animated_chibi_overload(t)
        draw_ascii_lines(draw, chibi_lines, 10, 200, font=FONT_ASCII_XS, color=TEXT_YELLOW, line_height=20)

        # Floating Panic Tags on Right
        tags_r = [
            "+-----------+",
            "| [!] HITL? |",
            "| XIN QUYỀN?|",
            "+-----------+",
            "| CONFLICT! |",
            "+-----------+",
        ]
        draw_ascii_lines(draw, tags_r, WIDTH - 165, 200, font=FONT_ASCII_XS, color=TEXT_RED, line_height=20)

        # Anime Flurry Barrage Punching Recommend
        fists = aae.get_animated_flurry_barrage(t)
        draw_ascii_lines(draw, fists, (WIDTH - 380) // 2, 1330, font=FONT_ASCII_SM, color=TEXT_CYAN, line_height=24)

        draw.rounded_rectangle((60, 1540, WIDTH - 60, 1680), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1590), "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 6:
        # === SCENE 6: Bài Thi Trắc Nghiệm HITL & Cái Kết ===
        # Circling Option C in Exam Paper
        pencil_step = int(t * 8) % 4
        if pencil_step == 0:
            c_tag = "  || (C) Nhắm mắt BẤM RECOMMEND cho nhanh! (99%) ||  "
            pencil_pos = "           \\====> (pencil circling)"
        elif pencil_step == 1:
            c_tag = "  ||[(C)]Nhắm mắt BẤM RECOMMEND cho nhanh! (99%) ||  "
            pencil_pos = "       \\====> (circling...)"
        elif pencil_step == 2:
            c_tag = "  || ((C)) Nhắm mắt BẤM RECOMMEND cho nhanh! (99%)|| "
            pencil_pos = "   \\====> (circled!)"
        else:
            c_tag = "  ||**[C]**Nhắm mắt BẤM RECOMMEND cho nhanh! (99%)|| "
            pencil_pos = "              \\====> *CHECKED!*"

        exam_ascii = [
            "+======================================================+",
            "| [?] BÀI THI TRẮC NGHIỆM HITL (MÃ ĐỀ: 2026)           |",
            "+======================================================+",
            "| Câu 1: AI vừa xin quyền chạy script 2,000 dòng.      |",
            "| Bạn sẽ làm gì để đúng chuẩn Human-In-The-Loop?       |",
            "|                                                      |",
            "|   [A] Đọc kỹ từng dòng code (Mất 15 phút suy nghĩ)   |",
            "|   [B] Từ chối và tự tay viết lại từ đầu              |",
            "|  .================================================.  |",
            c_tag,
            "|  '================================================'  |",
            pencil_pos,
            "+======================================================+",
        ]
        draw_ascii_lines(draw, exam_ascii, 60, 130, font=FONT_ASCII, color=TEXT_WHITE, line_height=32)

        # Red Rubber Stamp with impact shockwave lines
        stamp_ascii = [
            "          \\ \\      |      / /",
            "   .----------------------------------------------.",
            "   |            APPROVED - HITL 10/10             |  *SLAM!*",
            "   '----------------------------------------------'",
            "          / /      |      \\ \\",
        ]
        draw_ascii_lines(draw, stamp_ascii, 60, 580, font=FONT_ASCII, color=TEXT_RED, line_height=34)

        # Soul Ghost floating smoothly upward
        ghost_lines = aae.get_animated_soul_ghost(t)
        ghost_drift = int(math.sin(t * 3) * 15)
        draw_ascii_lines(draw, ghost_lines, 60 + ghost_drift, 760, font=FONT_ASCII, color=TEXT_CYAN, line_height=30)

        # Slumped Dev on floor
        slump_lines = [
            "           _                         _",
            "          [=]     _.(x_x)._         [=]  (Kiệt sức...)",
            "         ===============================",
        ]
        draw_ascii_lines(draw, slump_lines, 60, 930, font=FONT_ASCII, color=TEXT_CYAN, line_height=32)

        banner_end = [
            "+======================================================+",
            "| [!] TỪ SÁNG ĐẾN ĐÊM CHỈ ĐỂ LÀM BÀI TRẮC NGHIỆM!      |",
            "+======================================================+",
        ]
        draw_ascii_lines(draw, banner_end, 60, 1080, font=FONT_ASCII, color=TEXT_YELLOW, line_height=38)

        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Bạn còn bận hơn cả lúc chưa có AI!", fill='#ffffff', font=FONT_TITLE)

    out_file = f'video/preview_anim_{scene_num}.png'
    im.save(out_file)
    print(f"Generated {out_file}")

if __name__ == '__main__':
    for s in range(1, 7):
        render_anim_test_frame(s, t=2.5)
