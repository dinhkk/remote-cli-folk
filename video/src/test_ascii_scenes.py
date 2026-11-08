import os
import sys
import math
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, 'video/src')
import terminal_ui as tui

WIDTH = 1080
HEIGHT = 1920

# Fonts
FONT_ASCII = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)
FONT_ASCII_SM = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 20)
FONT_ASCII_XS = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 16)
FONT_ASCII_LG = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 32)
FONT_ASCII_HERO = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 38)

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

def draw_ascii_lines(draw, lines, x, y, font=FONT_ASCII, color=TEXT_WHITE, line_height=28):
    for i, line in enumerate(lines):
        draw.text((x, y + i * line_height), line, fill=color, font=font)

def render_ascii_preview(scene_num):
    im = Image.new('RGB', (WIDTH, HEIGHT), '#090d16')
    draw = ImageDraw.Draw(im)

    # Device Status Bar & Safari Bar at top
    tui.draw_mobile_header(draw, active_tab='Home-PC' if scene_num != 3 else 'Laptop')

    if scene_num == 1:
        # === SCENE 1: Nghịch Lý AI & HITL ===
        # Terminal Header
        draw.rounded_rectangle((35, 230, WIDTH - 35, 1420), radius=18, fill='#060910', outline='#1e293b', width=2)
        draw.text((60, 250), ">_ PowerShell Terminal (HITL Active)", fill=TEXT_CYAN, font=FONT_BOLD)

        # Code block
        code_lines = [
            "$tokenBudget = 1000000; # Max quota burn",
            "while ($true) {",
            "    $task = Invoke-ClaudeAgent -Loop dynamic",
            "    if ($task.NeedsApproval) {",
            "        Wait-For-Human-In-The-Loop -Timeout Infinite",
            "    }",
            "}"
        ]
        draw_ascii_lines(draw, code_lines, 60, 310, font=FONT_ASCII_SM, color=TEXT_GREEN, line_height=34)

        # ASCII Robot on Left
        robot_ascii = [
            "         (*)",
            "          |",
            "     .--------.",
            "    |[  O  O  ]|",
            "    |   ====   |",
            "    '----------'",
            "   .-'----------'-.",
            "  / | TOKENS:     | \\",
            " =  | [ 138,750 ] |  =",
            "  \\ |_____________| /",
            "   \\==[ CLAUDE ]==/",
            "   [__|_|_|_|_|_|_|]",
            "       typing...",
        ]
        draw_ascii_lines(draw, robot_ascii, 60, 620, font=FONT_ASCII, color=TEXT_GREEN, line_height=30)

        # ASCII Stressed Dev on Right
        dev_ascii = [
            "      \\ \\  |  / /",
            "        .-----.",
            "       / >   < \\ ;",
            "      |  (o_o)  |;",
            "     / \\   O   / \\",
            "    /   '-----'   \\",
            "   / /|  HITL!  | \\ \\",
            "  *   | CANH AI |   *",
            "      '---------'",
            "        >     <",
            "       [===] [===]",
            "      (dep to ong)",
        ]
        draw_ascii_lines(draw, dev_ascii, 620, 620, font=FONT_ASCII, color=TEXT_RED, line_height=30)

        # ASCII Warning Stamps below
        banner_1 = [
            "+---------------------------------------------------+",
            "| [!] DOT TOKEN NGAY DEM CHO DO PHI QUOTA!          |",
            "+---------------------------------------------------+",
            "| [!] CHUAN HITL: PHAI NGOI CANH TUNG LI TUNG TY!   |",
            "+---------------------------------------------------+",
        ]
        draw_ascii_lines(draw, banner_1, 100, 1120, font=FONT_ASCII, color=TEXT_YELLOW, line_height=32)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 2:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        draw.rounded_rectangle((35, 230, WIDTH - 35, 1420), radius=18, fill='#060910', outline='#1e293b', width=2)
        draw.text((60, 250), ">_ Remote Session • QuanTraDa_ViaHe.session", fill=TEXT_CYAN, font=FONT_BOLD)

        # ASCII Chat Bubbles
        chat_box = [
            "+---------------------------------------------------+",
            "| [23:26] Dev: Ghe tra da lam coc di anh em oi!     |",
            "| [23:26] Claude: Da em refactor xong 3 module roi! |",
            "| [23:27] Dev: Chat AI suong nhu nhan tin voi ghe!  |",
            "+---------------------------------------------------+",
        ]
        draw_ascii_lines(draw, chat_box, 60, 310, font=FONT_ASCII, color=TEXT_CYAN, line_height=32)

        # ASCII Relaxed Dev sitting on plastic stool
        dev_trada = [
            "         .-----.",
            "        /       \\",
            "       |  (^_^)  |   <3 Chat voi ghe!",
            "        \\   =   /",
            "      .--'-----'--.",
            "     / |  [<3]  | \\",
            "    *  |  PHONE |  *",
            "       '---------'",
            "       / /     \\ \\",
            "      /_/       \\_|  *nhip gio*",
            "     [===]     [===]  (dep to ong)",
            "   =================  (ghe nhua Duy Tan)",
        ]
        draw_ascii_lines(draw, dev_trada, 60, 580, font=FONT_ASCII, color=TEXT_CYAN, line_height=30)

        # ASCII Trà Đá Crate Table
        table_trada = [
            "        ~   ~    (khoi tra da lanh)",
            "       .--------.",
            "       | \\ [ICE]|",
            "       |  \\     |   (coc tra da chanh)",
            "       |   \\    |",
            "       '--------'",
            "       ( o o o o )  (dia huong duong)",
            "    .==============.",
            "    |  [#]    [#]  |",
            "    |  KET TRÀ ĐÁ  |",
            "    '=============='",
        ]
        draw_ascii_lines(draw, table_trada, 600, 580, font=FONT_ASCII, color=TEXT_YELLOW, line_height=30)

        # ASCII Punchline Banner
        punch_ascii = [
            "+===================================================+",
            "| [!] DANG YEN DANG LANH TU NHIEN LAI GANH THE VIEC!|",
            "+===================================================+",
        ]
        draw_ascii_lines(draw, punch_ascii, 60, 1150, font=FONT_ASCII_HERO, color=TEXT_RED, line_height=42)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 3:
        # === SCENE 3: Hồi Sinh PC, Laptop, VPS & Chuyển Máy 1 Tab ===
        draw.rounded_rectangle((35, 230, WIDTH - 35, 1420), radius=18, fill='#060910', outline='#1e293b', width=2)
        draw.text((60, 250), ">_ Ecosystem Manager • 1-Tab Switching", fill=TEXT_CYAN, font=FONT_BOLD)

        # ASCII Multi-Device Cluster
        ecosystem_ascii = [
            "    [Home-PC]               [Laptop]               [VPS CLOUD]",
            "  .------------.         .------------.              .---.",
            "  | > Home-PC  |         |   Laptop   |            (  VPS  )",
            "  | ONLINE 24/7|         | Worker #2  |           ( CLOUD #3)",
            "  '------------'         '------------'            '-------'",
            "     / /  \\ \\           /==============\\           [ # # # ]",
            "    [========]          \\______________/           [ # # # ]",
            "         |                      |                      |",
            "         +======================+======================+",
            "                                |",
            "                      v v v v v v v v v v",
            "             =====================================",
            "             >> CHUYEN MAY CHI BANG 1 CAI TAB! <<",
            "             =====================================",
        ]
        draw_ascii_lines(draw, ecosystem_ascii, 60, 360, font=FONT_ASCII, color=TEXT_CYAN, line_height=34)

        # Big ASCII Banner
        tab_banner = [
            "+---------------------------------------------------+",
            "| [TAB 1: Local]   [TAB 2: Home-PC]   [TAB 3: Laptop]|",
            "+---------------------------------------------------+",
            "|      * ZERO LATENCY MULTI-DEVICE TERMINAL *       |",
            "+---------------------------------------------------+",
        ]
        draw_ascii_lines(draw, tab_banner, 60, 950, font=FONT_ASCII, color=TEXT_GREEN, line_height=32)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 4:
        # === SCENE 4: Bùng Nổ Projects (5-6 Projects, 47 Sessions) ===
        # REAL Screenshot 1 from user!
        p_w, p_h = 560, 1160
        p_scaled = MOCKUP_1.resize((p_w, p_h), Image.Resampling.LANCZOS)
        p_x = (WIDTH - p_w) // 2
        p_y = 230
        im.paste(p_scaled, (p_x, p_y), p_scaled)

        # Animated ASCII reticle / bracket around the real UAV card (47 sessions)
        # UAV is located roughly around y = 840 on the scaled mockup
        uav_y = p_y + 610
        draw.rectangle((p_x + 10, uav_y, p_x + p_w - 10, uav_y + 85), outline='#ef4444', width=4)

        # ASCII Callout pointing to UAV
        uav_tag = [
            "===> [!] UAV: 47 SESSIONS! <===",
            "     (HOT PROJECT OVERLOAD!)   ",
        ]
        draw_ascii_lines(draw, uav_tag, p_x + 20, uav_y - 70, font=FONT_ASCII_SM, color=TEXT_YELLOW, line_height=26)

        # Floating ASCII tags Left & Right of the real phone
        tag_left = [
            "+---------------+",
            "| [!] 5-6 PROJ  |",
            "| CUNG MOT LUC! |",
            "+---------------+",
        ]
        draw_ascii_lines(draw, tag_left, 25, 450, font=FONT_ASCII_SM, color=TEXT_CYAN, line_height=24)

        tag_right = [
            "+---------------+",
            "| [!] 47 SESS   |",
            "| NHAY LIEN TUC!|",
            "+---------------+",
        ]
        draw_ascii_lines(draw, tag_right, WIDTH - 240, 450, font=FONT_ASCII_SM, color=TEXT_RED, line_height=24)

        # ASCII Total Banner
        tot_ascii = [
            "+===================================================+",
            "| [!] TONG CONG: 57 SESSIONS DANG CHAY DONG THOI!   |",
            "+===================================================+",
        ]
        draw_ascii_lines(draw, tot_ascii, 60, 1360, font=FONT_ASCII, color=TEXT_RED, line_height=32)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 5:
        # === SCENE 5: Phân Mảnh Context & 90 Tin Nhắn ===
        # REAL Screenshot 2 from user!
        p_w, p_h = 560, 1160
        p_scaled = MOCKUP_2.resize((p_w, p_h), Image.Resampling.LANCZOS)
        p_x = (WIDTH - p_w) // 2
        p_y = 230
        im.paste(p_scaled, (p_x, p_y), p_scaled)

        # Real Screenshot Target Reticle on 90 Unread Messages Badge
        reticle_x = p_x + 205
        reticle_y = p_y + 980
        draw.rectangle((reticle_x - 30, reticle_y - 20, reticle_x + 30, reticle_y + 20), outline='#ef4444', width=4)
        draw.text((reticle_x - 45, reticle_y - 45), "[ 90 TIN NHAN! ]", fill=TEXT_RED, font=FONT_ASCII_SM)

        # ASCII Chibi Overloaded Dev on Upper Right
        chibi_ascii = [
            " (~)       (~)",
            "  \\ .-----. /",
            "---|( @ @ )|---",
            "   |   O   |",
            "   '-------'",
            "   (PANIC!)",
        ]
        draw_ascii_lines(draw, chibi_ascii, WIDTH - 260, 320, font=FONT_ASCII_SM, color=TEXT_YELLOW, line_height=24)

        # ASCII Anime Flurry Barrage Punching Bottom Recommend Action
        flurry_ascii = [
            "  ==O             O==",
            "         ==O",
            "   ==O           ==O",
            "+---------------------+",
            "| [ BẤM RECOMMEND ]   |",
            "+---------------------+",
            "  ==O             ==O",
        ]
        draw_ascii_lines(draw, flurry_ascii, (WIDTH - 420) // 2, 1220, font=FONT_ASCII, color=TEXT_CYAN, line_height=26)

        # Warning Stamp
        draw_ascii_lines(draw, ["+---------------------------------------------------+", "| TOAN NHAM MAT BAM RECOMMEND VI KHONG KIP NGHI!    |", "+---------------------------------------------------+"], 60, 1370, font=FONT_ASCII_SM, color=TEXT_RED, line_height=24)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", fill='#ffffff', font=FONT_TITLE)

    elif scene_num == 6:
        # === SCENE 6: Bài Thi Trắc Nghiệm & Cái Kết ===
        # Full ASCII Exam Paper
        exam_ascii = [
            "+---------------------------------------------------+",
            "| [?] BÀI THI TRẮC NGHIỆM HITL (MÃ ĐỀ: 2026)        |",
            "+---------------------------------------------------+",
            "| Câu 1: AI vừa xin quyền chạy script 2,000 dòng.   |",
            "| Bạn sẽ làm gì để đúng chuẩn Human-In-The-Loop?    |",
            "|                                                   |",
            "|  [A] Đọc kỹ từng dòng code (Mất 15 phút)          |",
            "|  [B] Từ chối và tự tay viết lại từ đầu            |",
            "| .===============================================. |",
            "| || (C) Nhắm mắt bấm RECOMMEND cho nhanh! (99%) || |",
            "| '===============================================' |",
            "+---------------------------------------------------+",
        ]
        draw_ascii_lines(draw, exam_ascii, 60, 260, font=FONT_ASCII, color=TEXT_WHITE, line_height=32)

        # Big Red ASCII Rubber Stamp APPROVED - HITL
        stamp_ascii = [
            "   .-------------------------------------.",
            "   |        APPROVED - HITL 10/10        |",
            "   '-------------------------------------'",
        ]
        draw_ascii_lines(draw, stamp_ascii, 180, 680, font=FONT_ASCII_LG, color=TEXT_RED, line_height=38)

        # ASCII Slumped Exhausted Dev with soul ghost
        slumped_ascii = [
            "                    .---.",
            "                   ( x_x )  <-- Cute soul ghost",
            "                  .'     '.     floating up...",
            "                 (  ~ ~ ~  )",
            "                  '-------'",
            "         _                         _",
            "        [=]     _.(x_x)._         [=]  (Kiet suc...)",
            "       ===============================",
        ]
        draw_ascii_lines(draw, slumped_ascii, 120, 840, font=FONT_ASCII, color=TEXT_CYAN, line_height=30)

        # Climax Outro Card
        outro_ascii = [
            "+===================================================+",
            "|         BẬN HƠN CẢ KHI CHƯA CÓ AI!                |",
            "|                                                   |",
            "| RemoteCLI: Giải phóng chiếc máy tính của bạn,     |",
            "| nhưng đừng để AI quản lý lại bạn!                 |",
            "+===================================================+",
        ]
        draw_ascii_lines(draw, outro_ascii, 60, 1180, font=FONT_ASCII, color=TEXT_YELLOW, line_height=34)

        # Subtitle
        draw.rounded_rectangle((60, 1440, WIDTH - 60, 1570), radius=20, fill='#111827', outline=TEXT_CYAN, width=3)
        draw.text((85, 1485), "Bạn còn bận hơn cả lúc chưa có AI!", fill='#ffffff', font=FONT_TITLE)

    # Device footer at very bottom
    tui.draw_mobile_footer(draw, tokens='126K', unread_count=90 if scene_num in (5, 6) else 0)

    out_file = f'video/preview_ascii_scene_{scene_num}.png'
    im.save(out_file)
    print(f"Generated {out_file}")

if __name__ == '__main__':
    for s in range(1, 7):
        render_ascii_preview(s)
