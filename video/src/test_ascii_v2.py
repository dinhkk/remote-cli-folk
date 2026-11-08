import os
import sys
import math
from PIL import Image, ImageDraw, ImageFont

WIDTH = 1080
HEIGHT = 1920

# Fonts
FONT_ASCII = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 28)
FONT_ASCII_HERO = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 34)
FONT_ASCII_SM = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 22)
FONT_ASCII_XS = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 18)

FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)

# Colors
BG_DARK = '#090d16'
TEXT_WHITE = '#f8fafc'
TEXT_GREEN = '#4ade80'
TEXT_CYAN = '#38bdf8'
TEXT_YELLOW = '#facc15'
TEXT_RED = '#f87171'
TEXT_PURPLE = '#c084fc'
TEXT_MUTED = '#94a3b8'

# Load Real Screenshots
MOCKUP_1 = Image.open('video/assets/mockups/mockup_phone_1.png').convert('RGBA')
MOCKUP_2 = Image.open('video/assets/mockups/mockup_phone_2.png').convert('RGBA')

def draw_ascii_lines(draw, lines, x, y, font=FONT_ASCII, color=TEXT_WHITE, line_height=34, color_rules=None):
    for i, line in enumerate(lines):
        ly = y + i * line_height
        c = color
        if color_rules:
            for pat, rule_c in color_rules:
                if pat in line:
                    c = rule_c
                    break
        draw.text((x, ly), line, fill=c, font=font)

def render_ascii_scene(scene_num, t=2.0):
    im = Image.new('RGB', (WIDTH, HEIGHT), BG_DARK)
    draw = ImageDraw.Draw(im)

    # Global Top Terminal Bar (gives an authentic hacker/terminal aesthetic)
    term_bar = [
        "+========================================================================+",
        f"| >_ RemoteCLI Terminal • Active Host: [Home-PC] • Latency: 12ms          |",
        "+========================================================================+",
    ]
    draw_ascii_lines(draw, term_bar, 40, 40, font=FONT_ASCII_SM, color=TEXT_CYAN, line_height=26)

    if scene_num == 1:
        # === SCENE 1: Nghịch Lý AI & HITL ===
        # PowerShell Terminal Header
        pws_header = [
            ".----------------------------------------------------------------------.",
            "| >_ Windows PowerShell (HITL Supervisor Active)                      |",
            "'----------------------------------------------------------------------'",
        ]
        draw_ascii_lines(draw, pws_header, 40, 130, font=FONT_ASCII_SM, color=TEXT_CYAN, line_height=26)

        # Code block
        code_lines = [
            "$tokenBudget = 1000000; # Max quota burn",
            "while ($true) {",
            "    $agent = Invoke-ClaudeCode -Model 'sonnet-5.5' -Loop Dynamic",
            "    if ($agent.NeedsApproval) {",
            "        Wait-For-Human-In-The-Loop -Timeout Infinite # Canh AI ca ngay!",
            "    }",
            "}"
        ]
        draw_ascii_lines(draw, code_lines, 60, 220, font=FONT_ASCII_SM, color=TEXT_GREEN, line_height=32)

        # Animated Big ASCII Robot on Left
        spark = "*" if int(t * 8) % 2 == 0 else "+"
        blink = "O   O" if math.sin(t * 10) > 0 else "-   -"
        claw = "\\" if int(t * 14) % 2 == 0 else "/"
        tok = int(142000 + (t * 9200) % 50000)

        robot_ascii = [
            f"             ({spark})",
            "              |",
            "         .--------.",
            f"        |[ {blink} ]|",
            "        |  ======  |",
            "        '----------'",
            "       .-'----------'-.",
            "      / |  TOKENS:    | \\",
            f"     =  | [{tok:,}]  |  =",
            "      \\ |_____________| /",
            f"       {claw}==[ CLAUDE ]=={claw}",
            "       [__|_|_|_|_|_|_|]",
            "          typing...",
        ]
        draw_ascii_lines(draw, robot_ascii, 40, 500, font=FONT_ASCII, color=TEXT_GREEN, line_height=36)

        # Animated Big Stressed Dev on Right
        sweat = ";" if int(t * 6) % 2 == 0 else " "
        tremor = math.sin(t * 22)
        mouth = "O" if tremor > 0 else "o"
        knee = ">   <" if tremor > 0 else "<   >"

        dev_ascii = [
            f"          \\ \\  |  / /  {sweat}",
            "            .-----.",
            f"           / >   < \\  {sweat}",
            f"          |  (o_o)  | {sweat}",
            f"         / \\   {mouth}   / \\",
            "        /   '-----'   \\",
            "       / /|  HITL!  |\\ \\",
            "      * * | CANH AI | * *",
            "          '---------'",
            f"            {knee}",
            "           [===] [===]",
            "          (dep to ong)",
        ]
        draw_ascii_lines(draw, dev_ascii, 540, 500, font=FONT_ASCII, color=TEXT_RED, line_height=36)

        # Large ASCII Warning Banners
        banners = [
            "+====================================================================+",
            "| [!] ĐỐT TOKEN NGÀY ĐÊM CHO ĐỠ PHÍ QUOTA!                           |",
            "+====================================================================+",
            "| [!] CHUẨN HITL: PHẢI NGỒI CANH TỪNG LI TỪNG TÝ!                    |",
            "+====================================================================+",
        ]
        draw_ascii_lines(draw, banners, 40, 1080, font=FONT_ASCII_HERO, color=TEXT_YELLOW, line_height=42)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 2:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        # Chat Session Box
        chat_box = [
            "+--------------------------------------------------------------------+",
            "| [23:26] Dev:    Ghé quán trà đá làm cốc đi anh em ơi!             |",
            "| [23:26] Claude: Dạ em đang refactor xong 3 module rồi ạ!           |",
            "| [23:27] Dev:    Chat AI sướng như nhắn tin với ghệ!                |",
            "+--------------------------------------------------------------------+",
        ]
        draw_ascii_lines(draw, chat_box, 40, 130, font=FONT_ASCII_SM, color=TEXT_CYAN, line_height=30)

        # Dev at Trà đá on Left
        tap = "/" if int(t * 14) % 2 == 0 else "\\"
        heart = "<3" if int(t * 4) % 2 == 0 else ".."

        dev_trada = [
            "             .-------.",
            "            /  _   _  \\",
            "           |  ( ^ _ ^ ) |   <3 Chat voi ghe!",
            "            \\    -    /",
            "          .---'-----'---.",
            f"         /  |   [{heart}]  |  \\",
            "        *   |  PHONE  |   * (nhan tin claude)",
            "            '---------'",
            "             / /   \\ \\",
            f"            /_/     {tap}_|   *nhip gio deu dan*",
            "           [===]   [===]  (dep to ong)",
            "        =================== (ghe nhua Duy Tan)",
        ]
        draw_ascii_lines(draw, dev_trada, 40, 480, font=FONT_ASCII, color=TEXT_CYAN, line_height=36)

        # Trà Đá Table on Right
        s1 = "~" if int(t * 6) % 2 == 0 else " "
        s2 = " " if int(t * 6) % 2 == 0 else "~"

        table_trada = [
            f"            {s1}   {s2}   {s1}       (khoi tra da lanh)",
            "          .-----------.",
            "          |   \\  [ICE]|",
            "          |    \\      |     (coc tra da 5k)",
            "          |     \\ [ICE|",
            "          '-----------'",
            "         ( o o o o o o )    (dia huong duong)",
            "       .=================.",
            "       |   [#]     [#]   |",
            "       |  KET BIA TRÀ ĐÁ |  (ke lam ban)",
            "       '================='",
        ]
        draw_ascii_lines(draw, table_trada, 560, 480, font=FONT_ASCII, color=TEXT_YELLOW, line_height=36)

        # Big ASCII Punchline Banner
        punch_ascii = [
            "+====================================================================+",
            "| [!] ĐANG YÊN ĐANG LÀNH TỰ NHIÊN GÁNH THÊM VIỆC!                   |",
            "+====================================================================+",
        ]
        draw_ascii_lines(draw, punch_ascii, 40, 1080, font=FONT_ASCII_HERO, color=TEXT_RED, line_height=42)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 3:
        # === SCENE 3: Hồi Sinh Máy Cũ & Chuyển Máy 1 Tab ===
        # Tab Bar
        active_tab_str = "[LAPTOP]" if int(t * 2) % 2 == 0 else "[HOME-PC]"
        tab_switcher = [
            "+--------------------------------------------------------------------+",
            f"| TABS: [Local]   ==> {active_tab_str} <==   [Cloud-VPS]   [PC-Lab]       |",
            "+--------------------------------------------------------------------+",
        ]
        draw_ascii_lines(draw, tab_switcher, 40, 130, font=FONT_ASCII, color=TEXT_YELLOW, line_height=32)

        # ASCII Multi-Device Cluster
        ecosystem_ascii = [
            "    [Home-PC]                 [Laptop]                 [Cloud-VPS]",
            "  .------------.           .------------.                .-----.  ",
            "  | > Home-PC  |           |  Laptop #2 |              (  VPS  ) ",
            "  | ONLINE 24/7|           |  Worker AI |             ( CLOUD #3) ",
            "  '------------'           '------------'              '-------'  ",
            "     / /  \\ \\             /==============\\             [ # # # ]  ",
            "    [========]            \\______________/             [ # # # ]  ",
            "         |                        |                        |      ",
            "         +========================+========================+      ",
            "                                  |                               ",
            "                        v v v v v v v v v v                       ",
            "               ======================================             ",
            "               >> CHUYỂN MÁY CHỈ BẰNG 1 CÁI TAB! <<               ",
            "               ======================================             ",
        ]
        draw_ascii_lines(draw, ecosystem_ascii, 40, 360, font=FONT_ASCII, color=TEXT_CYAN, line_height=36)

        # Bottom Banner
        banner_3 = [
            "+====================================================================+",
            "| * ZERO-LATENCY MULTI-DEVICE TERMINAL MANAGER *                     |",
            "+====================================================================+",
        ]
        draw_ascii_lines(draw, banner_3, 40, 1080, font=FONT_ASCII_HERO, color=TEXT_GREEN, line_height=42)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 4:
        # === SCENE 4: BÙNG NỔ 5-6 PROJECTS (REAL Screenshot 1) ===
        # Scale mockup_phone_1 cleanly
        scale = 1.35
        p_w = int(520 * scale) # 702
        p_h = int(1080 * scale) # 1458
        p_x = (WIDTH - p_w) // 2 # 189
        p_y = 60

        # Drop shadow behind real image
        draw.rounded_rectangle((p_x - 10, p_y - 10, p_x + p_w + 10, p_y + p_h + 10), radius=28, fill='#040711', outline='#1e293b', width=3)

        # Paste REAL Image 1
        scaled_m1 = MOCKUP_1.resize((p_w, p_h), Image.Resampling.LANCZOS)
        im.paste(scaled_m1, (p_x, p_y), scaled_m1)

        # UAV Card is at y = 705..765 on original 1080h image
        uav_orig_y = 705
        uav_y = int(p_y + uav_orig_y * scale)
        uav_h = int(60 * scale)

        # Animated Red Target Bracket directly on the real UAV card
        pulse_col = '#ef4444' if math.sin(t * 12) > 0 else '#f87171'
        draw.rounded_rectangle((p_x + 12, uav_y, p_x + p_w - 12, uav_y + uav_h), radius=10, outline=pulse_col, width=5)

        # Callout tag on UAV
        uav_callout = [
            "===> [!] UAV: 47 SESSIONS! <===",
        ]
        draw_ascii_lines(draw, uav_callout, p_x + 20, uav_y - 36, font=FONT_ASCII_SM, color=TEXT_YELLOW, line_height=26)

        # Floating ASCII tags on Left & Right sides of the screen
        tag_l = [
            "+---------------+",
            "| [!] 5-6 PROJ  |",
            "| CÙNG MỘT LÚC! |",
            "+---------------+",
        ]
        draw_ascii_lines(draw, tag_l, 10, 380, font=FONT_ASCII_XS, color=TEXT_CYAN, line_height=22)

        tag_r = [
            "+---------------+",
            "| [!] 47 SESS   |",
            "| NHẢY LIÊN TỤC!|",
            "+---------------+",
        ]
        draw_ascii_lines(draw, tag_r, WIDTH - 185, 380, font=FONT_ASCII_XS, color=TEXT_RED, line_height=22)

        # Subtitle
        draw.rounded_rectangle((60, 1540, WIDTH - 60, 1680), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1590), "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 5:
        # === SCENE 5: PHÂN MẢNH CONTEXT & 90 TIN NHẮN (REAL Screenshot 2) ===
        scale = 1.35
        p_w = int(520 * scale) # 702
        p_h = int(1080 * scale) # 1458
        p_x = (WIDTH - p_w) // 2 # 189
        p_y = 60

        # Drop shadow behind real image
        draw.rounded_rectangle((p_x - 10, p_y - 10, p_x + p_w + 10, p_y + p_h + 10), radius=28, fill='#040711', outline='#1e293b', width=3)

        # Paste REAL Image 2
        scaled_m2 = MOCKUP_2.resize((p_w, p_h), Image.Resampling.LANCZOS)
        im.paste(scaled_m2, (p_x, p_y), scaled_m2)

        # Target Reticle on 90 Unread Messages Badge (x = 176..215, y = 894..914)
        bx = int(p_x + 195 * scale)
        by = int(p_y + 904 * scale)
        draw.ellipse((bx - 35, by - 25, bx + 35, by + 25), outline='#ef4444', width=4)
        draw.line([(bx - 50, by), (bx + 50, by)], fill='#ef4444', width=3)
        draw.line([(bx, by - 40), (bx, by + 40)], fill='#ef4444', width=3)

        # Callout on 90 badge
        draw.text((bx - 70, by - 70), "[ 90 TIN NHẮN! ]", fill=TEXT_RED, font=FONT_ASCII_SM)

        # ASCII Chibi Overloaded Dev on Upper Left
        chibi_ascii = [
            " (~)       (~)",
            "  \\ .-----. /",
            "---|( @ @ )|---",
            "   |   O   |",
            "   '-------'",
            "   (PANIC!)",
        ]
        draw_ascii_lines(draw, chibi_ascii, 15, 200, font=FONT_ASCII_XS, color=TEXT_YELLOW, line_height=22)

        # ASCII Anime Flurry Barrage on Bottom Center
        fists = [
            "  ==O             O==",
            "         ==O",
            "   ==O           ==O",
            "+---------------------+",
            "| [ BẤM RECOMMEND ]   |",
            "+---------------------+",
            "  ==O             ==O",
        ]
        draw_ascii_lines(draw, fists, (WIDTH - 380) // 2, 1340, font=FONT_ASCII_SM, color=TEXT_CYAN, line_height=26)

        # Subtitle
        draw.rounded_rectangle((60, 1540, WIDTH - 60, 1680), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1590), "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 6:
        # === SCENE 6: Bài Thi Trắc Nghiệm HITL & Cái Kết ===
        # Full ASCII Exam Paper
        exam_ascii = [
            "+====================================================================+",
            "| [?] BÀI THI TRẮC NGHIỆM HITL (MÃ ĐỀ: 2026)                         |",
            "+====================================================================+",
            "| Câu 1: AI vừa xin quyền chạy script 2,000 dòng.                    |",
            "| Bạn sẽ làm gì để đúng chuẩn Human-In-The-Loop?                     |",
            "|                                                                    |",
            "|   [A] Đọc kỹ từng dòng code (Mất 15 phút suy nghĩ)                 |",
            "|   [B] Từ chối và tự tay viết lại từ đầu                            |",
            "|  .==============================================================.  |",
            "|  || (C) Nhắm mắt bấm RECOMMEND cho nhanh! (Đã chọn 99 lần)   ||  |",
            "|  '=============================================================='  |",
            "+====================================================================+",
        ]
        draw_ascii_lines(draw, exam_ascii, 40, 130, font=FONT_ASCII, color=TEXT_WHITE, line_height=36)

        # Big Red Rubber Stamp
        stamp_ascii = [
            "   .--------------------------------------------------.",
            "   |            APPROVED - HITL 10/10                 |",
            "   '--------------------------------------------------'",
        ]
        draw_ascii_lines(draw, stamp_ascii, 100, 620, font=FONT_ASCII_HERO, color=TEXT_RED, line_height=42)

        # Slumped Dev on floor with cute floating soul ghost
        slumped_ascii = [
            "                        .---.",
            "                       ( x_x )  <-- Linh hồn bay lên...",
            "                      .'     '.",
            "                     (  ~ ~ ~  )",
            "                      '-------'",
            "             _                         _",
            "            [=]     _.(x_x)._         [=]  (Kiệt sức...)",
            "           ===============================",
        ]
        draw_ascii_lines(draw, slumped_ascii, 60, 780, font=FONT_ASCII, color=TEXT_CYAN, line_height=34)

        # Final Outro Card
        outro_ascii = [
            "+====================================================================+",
            "|                  BẬN HƠN CẢ KHI CHƯA CÓ AI!                        |",
            "|                                                                    |",
            "| RemoteCLI: Giải phóng chiếc máy tính của bạn,                      |",
            "| nhưng đừng để AI quản lý lại bạn!                                  |",
            "+====================================================================+",
        ]
        draw_ascii_lines(draw, outro_ascii, 40, 1120, font=FONT_ASCII_HERO, color=TEXT_YELLOW, line_height=42)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Bạn còn bận hơn cả lúc chưa có AI!", fill='#ffffff', font=FONT_TITLE)

    out_file = f'video/preview_v2_scene_{scene_num}.png'
    im.save(out_file)
    print(f"Generated {out_file}")

if __name__ == '__main__':
    for s in range(1, 7):
        render_ascii_scene(s)
