import math
from PIL import Image, ImageDraw, ImageFont

# Canvas dimensions
WIDTH = 1080
HEIGHT = 1920

# Colors matching authentic RemoteCLI dark theme (from screenshots)
BG_APP = '#0f141c'        # Main app dark background
BG_SURFACE = '#161e2e'    # Card / block surface
BG_TERMINAL = '#090d16'   # Inner terminal code box
BORDER_COLOR = '#1e293b'  # Subtle border
BORDER_ACTIVE = '#38bdf8' # Active border / focus
TEXT_WHITE = '#f8fafc'
TEXT_MUTED = '#94a3b8'
TEXT_CODE = '#4ade80'     # Green PowerShell code
TEXT_CYAN = '#38bdf8'
TEXT_YELLOW = '#facc15'
TEXT_RED = '#f87171'

# Fonts
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 34)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 24)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)
FONT_XS = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 18)
FONT_CODE = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 22)
FONT_CODE_BOLD = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 42)

def draw_mobile_header(draw, active_tab='Home-PC', url='vibexai.net'):
    """
    Renders authentic mobile device status bar + Safari browser bar + RemoteCLI tab bar
    exactly as seen in the user's screenshots.
    """
    # 1. Device Status Bar (23:25, Wifi, Battery 100)
    draw.rectangle((0, 0, WIDTH, 175), fill=BG_APP)
    draw.text((65, 30), "23:25", fill=TEXT_WHITE, font=FONT_BOLD)

    # Dynamic Island / Camera Notch Pill
    draw.rounded_rectangle(((WIDTH - 240) // 2, 22, (WIDTH + 240) // 2, 62), radius=20, fill='#000000')
    draw.ellipse(((WIDTH + 140) // 2, 34, (WIDTH + 140) // 2 + 16, 50), fill='#0f172a')

    # Battery & Signal on right
    draw.text((WIDTH - 180, 30), "100%", fill=TEXT_WHITE, font=FONT_BOLD)
    draw.rounded_rectangle((WIDTH - 95, 34, WIDTH - 55, 58), radius=6, outline=TEXT_WHITE, width=2)
    draw.rectangle((WIDTH - 91, 38, WIDTH - 59, 54), fill='#22c55e')
    draw.rectangle((WIDTH - 54, 42, WIDTH - 51, 50), fill=TEXT_WHITE)

    # 2. Safari Browser Address Bar
    bar_y = 75
    draw.rounded_rectangle((40, bar_y, WIDTH - 40, bar_y + 60), radius=16, fill='#1e293b', outline='#334155', width=2)
    # Lock icon (drawn with geometric shapes)
    draw.rounded_rectangle((68, bar_y + 24, 88, bar_y + 44), radius=3, fill='#94a3b8')
    draw.arc((72, bar_y + 14, 84, bar_y + 26), start=180, end=360, fill='#94a3b8', width=2)

    # URL centered with dynamic width
    bbox = draw.textbbox((0, 0), url, font=FONT_REGULAR)
    url_w = bbox[2] - bbox[0]
    draw.text(((WIDTH - url_w) // 2, bar_y + 14), url, fill=TEXT_WHITE, font=FONT_REGULAR)

    # Reload icon
    draw.arc((WIDTH - 85, bar_y + 18, WIDTH - 63, bar_y + 40), start=30, end=310, fill='#94a3b8', width=3)
    draw.polygon([(WIDTH - 65, bar_y + 15), (WIDTH - 58, bar_y + 26), (WIDTH - 72, bar_y + 26)], fill='#94a3b8')

    # 3. RemoteCLI Multi-Device Tab Bar
    tab_y = 150
    tabs = [
        ("Local", False, None),
        ("Home-PC", active_tab == 'Home-PC', '#22c55e'),
        ("Laptop", active_tab == 'Laptop', '#f59e0b'),
        ("PC", active_tab == 'PC', '#22c55e'),
    ]

    tx = 45
    for t_name, is_act, dot_col in tabs:
        # Tab button width
        tw = len(t_name) * 16 + (45 if dot_col else 30)
        t_box = (tx, tab_y, tx + tw, tab_y + 44)
        if is_act:
            draw.rounded_rectangle(t_box, radius=12, fill='#1e293b', outline='#0066FF', width=3)
        else:
            draw.rounded_rectangle(t_box, radius=12, fill='#111827', outline='#1f2937', width=1)

        cur_x = tx + 14
        if dot_col:
            # Active green / orange dot
            draw.ellipse((cur_x, tab_y + 16, cur_x + 12, tab_y + 28), fill=dot_col)
            cur_x += 20

        draw.text((cur_x, tab_y + 8), t_name, fill=TEXT_WHITE if is_act else TEXT_MUTED, font=FONT_SM)
        tx += tw + 18

    # Counter dot "● 0" on the far right
    draw.rounded_rectangle((WIDTH - 105, tab_y, WIDTH - 45, tab_y + 44), radius=12, fill='#111827', outline='#1f2937', width=1)
    draw.text((WIDTH - 90, tab_y + 10), "● 0", fill=TEXT_MUTED, font=FONT_SM)

    # Divider line
    draw.line([(0, 208), (WIDTH, 208)], fill='#1f2937', width=2)

def draw_mobile_footer(draw, tokens='126K', unread_count=90, model='gemini-3...'):
    """
    Renders authentic mobile bottom input bar & navigation matching Image 2.
    Clean vector glyphs to prevent font tofu boxes.
    """
    fy = 1750
    # Footer background
    draw.rectangle((0, fy - 160, WIDTH, HEIGHT), fill=BG_APP)
    draw.line([(0, fy - 160), (WIDTH, fy - 160)], fill='#1f2937', width=2)

    # Input Box Bar
    in_box = (35, fy - 145, WIDTH - 35, fy - 75)
    draw.rounded_rectangle(in_box, radius=16, fill='#161e2e', outline='#334155', width=2)
    draw.text((55, fy - 128), "Type / for commands, @ for files, or ask Claude...", fill='#64748b', font=FONT_SM)

    # Status pills below input box
    # Paperclip icon
    clip_x = 55
    clip_y = fy - 52
    draw.arc((clip_x, clip_y - 8, clip_x + 12, clip_y + 4), start=180, end=360, fill='#94a3b8', width=2)
    draw.line([(clip_x, clip_y - 2), (clip_x, clip_y + 14)], fill='#94a3b8', width=2)
    draw.arc((clip_x, clip_y + 6, clip_x + 18, clip_y + 20), start=0, end=180, fill='#94a3b8', width=2)
    draw.line([(clip_x + 18, clip_y - 4), (clip_x + 18, clip_y + 14)], fill='#94a3b8', width=2)

    # Token counter pill
    draw.rounded_rectangle((85, fy - 62, 175, fy - 22), radius=10, fill='#1e293b', outline='#334155', width=1)
    draw.text((100, fy - 56), tokens, fill=TEXT_WHITE, font=FONT_XS)

    # Unread messages badge
    if unread_count > 0:
        draw.rounded_rectangle((190, fy - 62, 275, fy - 22), radius=10, fill='#0284c7', outline='#38bdf8', width=2)
        # Mini speech bubble
        bx = 205
        by = fy - 52
        draw.rounded_rectangle((bx, by, bx + 16, by + 12), radius=3, fill='#ffffff')
        draw.polygon([(bx + 3, by + 12), (bx + 8, by + 12), (bx + 2, by + 16)], fill='#ffffff')
        draw.text((bx + 22, fy - 56), str(unread_count), fill=TEXT_WHITE, font=FONT_BOLD)

    # Model pill
    draw.rounded_rectangle((295, fy - 62, 450, fy - 22), radius=10, fill='#1e293b', outline='#334155', width=1)
    # Mini clock
    draw.circle((315, fy - 42), 7, outline=TEXT_MUTED, width=1)
    draw.line([(315, fy - 42), (315, fy - 46)], fill=TEXT_MUTED, width=1)
    draw.line([(315, fy - 42), (318, fy - 42)], fill=TEXT_MUTED, width=1)
    draw.text((328, fy - 56), model, fill=TEXT_WHITE, font=FONT_XS)

    # Send button on right
    send_box = (WIDTH - 120, fy - 66, WIDTH - 45, fy - 18)
    draw.rounded_rectangle(send_box, radius=12, fill='#0066FF', outline='#38bdf8', width=2)
    # Send arrow
    sx = WIDTH - 92
    sy = fy - 42
    draw.polygon([(sx, sy - 12), (sx + 20, sy), (sx, sy + 12), (sx + 6, sy)], fill='#ffffff')

    # Safari Bottom bar
    draw.line([(0, fy), (WIDTH, fy)], fill='#1f2937', width=1)
    # Left arrow <
    draw.line([(95, fy + 35), (80, fy + 48), (95, fy + 60)], fill=TEXT_WHITE, width=3)
    # Right arrow >
    draw.line([(290, fy + 35), (305, fy + 48), (290, fy + 60)], fill='#64748b', width=3)
    # Plus +
    draw.line([(500, fy + 48), (530, fy + 48)], fill=TEXT_WHITE, width=3)
    draw.line([(515, fy + 33), (515, fy + 63)], fill=TEXT_WHITE, width=3)
    # Tab counter [52]
    draw.rounded_rectangle((715, fy + 34, 755, fy + 62), radius=6, outline=TEXT_WHITE, width=2)
    draw.text((722, fy + 36), "52", fill=TEXT_WHITE, font=FONT_XS)
    # More ...
    for mi in range(3):
        draw.circle((920 + mi * 14, fy + 48), 3, fill=TEXT_WHITE)

    # Home indicator bar
    draw.rounded_rectangle(((WIDTH - 280) // 2, HEIGHT - 20, (WIDTH + 280) // 2, HEIGHT - 10), radius=5, fill='#ffffff')

def draw_terminal_chat_view(draw, top_y=220, bottom_y=1600):
    """
    Renders active terminal chat session matching Image 2.
    Uses clean drawn vector icons to avoid missing font glyphs.
    """
    # Session Toolbar: [Chat] [Terminal >_] [Files] [Git]
    tool_y = top_y + 10
    # Left: Hamburger menu (3 horizontal lines)
    for li in range(3):
        draw.line([(45, tool_y + 16 + li * 8), (70, tool_y + 16 + li * 8)], fill=TEXT_WHITE, width=3)

    # Claude Code logo badge (orange box with spark)
    draw.rounded_rectangle((85, tool_y + 6, 125, tool_y + 46), radius=8, fill='#f97316')
    draw.polygon([(105, tool_y + 10), (108, tool_y + 22), (120, tool_y + 26), (108, tool_y + 30), (105, tool_y + 42), (102, tool_y + 30), (90, tool_y + 26), (102, tool_y + 22)], fill='#ffffff')

    draw.text((135, tool_y + 4), "Claude Code", fill=TEXT_WHITE, font=FONT_SM)
    draw.text((135, tool_y + 26), "pos", fill=TEXT_MUTED, font=FONT_XS)

    # Right: Mode Selector Tabs
    btn_x = WIDTH - 430
    draw.rounded_rectangle((btn_x, tool_y + 4, btn_x + 115, tool_y + 50), radius=10, fill='#1e293b', outline='#0066FF', width=2)
    # Mini chat icon
    draw.rounded_rectangle((btn_x + 12, tool_y + 16, btn_x + 32, tool_y + 34), radius=4, fill='#38bdf8')
    draw.polygon([(btn_x + 16, tool_y + 34), (btn_x + 22, tool_y + 34), (btn_x + 14, tool_y + 40)], fill='#38bdf8')
    draw.text((btn_x + 40, tool_y + 12), "Chat", fill=TEXT_WHITE, font=FONT_SM)

    # Terminal prompt icon >_
    draw.text((btn_x + 145, tool_y + 12), ">_", fill=TEXT_MUTED, font=FONT_BOLD)

    # Folder icon
    fx = btn_x + 215
    fy = tool_y + 16
    draw.polygon([(fx, fy + 4), (fx + 10, fy + 4), (fx + 14, fy + 8), (fx + 26, fy + 8), (fx + 26, fy + 24), (fx, fy + 24)], fill=TEXT_MUTED)

    # Lightning bolt
    lx = btn_x + 275
    ly = tool_y + 14
    draw.polygon([(lx + 10, ly), (lx + 2, ly + 14), (lx + 8, ly + 14), (lx + 4, ly + 28), (lx + 16, ly + 10), (lx + 9, ly + 10)], fill=TEXT_MUTED)

    draw.line([(30, tool_y + 65), (WIDTH - 30, tool_y + 65)], fill='#1f2937', width=1)

    # PowerShell Code Execution Block
    code_y = tool_y + 85
    draw.rounded_rectangle((35, code_y, WIDTH - 35, code_y + 360), radius=16, fill=BG_TERMINAL, outline='#1e293b', width=2)

    # Code Header
    draw.text((60, code_y + 16), ">_", fill='#22c55e', font=FONT_BOLD)
    # Right action icons (Copy icon)
    cx = WIDTH - 120
    draw.rectangle((cx, code_y + 18, cx + 18, code_y + 38), outline=TEXT_MUTED, width=2)
    draw.rectangle((cx + 6, code_y + 24, cx + 24, code_y + 44), outline=TEXT_MUTED, width=2)

    # Download arrow icon
    dx = WIDTH - 65
    draw.line([(dx + 9, code_y + 18), (dx + 9, code_y + 36)], fill=TEXT_MUTED, width=2)
    draw.polygon([(dx + 3, code_y + 32), (dx + 15, code_y + 32), (dx + 9, code_y + 40)], fill=TEXT_MUTED)

    # Code lines
    code_lines = [
        ("$ $desktop = [System.Environment]::GetFolderPath(", '#4ade80'),
        ("   [System.Environment+SpecialFolder]::Desktop)", '#4ade80'),
        ("Write-Host \"Desktop: $desktop\"", '#4ade80'),
        ("Test-Path $desktop", '#4ade80'),
    ]
    for c_i, (c_text, c_col) in enumerate(code_lines):
        draw.text((60, code_y + 60 + c_i * 44), c_text, fill=c_col, font=FONT_CODE_BOLD)

    # Note below code block
    draw.text((60, code_y + 250), "Check Desktop path", fill='#64748b', font=FONT_REGULAR)

    # Collapsible Thinking Block
    think_y = code_y + 385
    # Brain bulb drawn icon
    draw.circle((72, think_y + 14), 10, outline='#94a3b8', width=2)
    draw.line([(68, think_y + 24), (76, think_y + 24)], fill='#94a3b8', width=2)
    draw.text((95, think_y), "Thought for a few seconds  v", fill='#94a3b8', font=FONT_BOLD)

    # Terminal Task Run Row 1
    t1_y = think_y + 65
    draw.line([(55, t1_y), (55, t1_y + 70)], fill='#22c55e', width=4)
    draw.text((75, t1_y + 15), "> $ PowerShell", fill=TEXT_WHITE, font=FONT_CODE_BOLD)
    draw.rounded_rectangle((285, t1_y + 12, 335, t1_y + 48), radius=8, fill='#1e293b')
    draw.text((298, t1_y + 16), "x2", fill=TEXT_MUTED, font=FONT_XS)
    draw.text((350, t1_y + 16), "/ $ps1Content = @' <#...", fill='#64748b', font=FONT_CODE)

    # Collapsible Thinking Block 2
    think2_y = t1_y + 85
    draw.circle((72, think2_y + 14), 10, outline='#94a3b8', width=2)
    draw.line([(68, think2_y + 24), (76, think2_y + 24)], fill='#94a3b8', width=2)
    draw.text((95, think2_y), "Thought for a few seconds  v", fill='#94a3b8', font=FONT_BOLD)

    # Terminal Task Run Row 2
    t2_y = think2_y + 65
    draw.line([(55, t2_y), (55, t2_y + 70)], fill='#22c55e', width=4)
    draw.text((75, t2_y + 15), "> $ PowerShell", fill=TEXT_WHITE, font=FONT_CODE_BOLD)
    draw.rounded_rectangle((285, t2_y + 12, 335, t2_y + 48), radius=8, fill='#1e293b')
    draw.text((298, t2_y + 16), "x4", fill=TEXT_MUTED, font=FONT_XS)
    draw.text((350, t2_y + 16), "/ $startupFolder = [S...", fill='#64748b', font=FONT_CODE)

def draw_projects_list_view(draw, top_y=220, bottom_y=1600):
    """
    Renders Projects overview view matching Image 1.
    Uses clean drawn vector icons to avoid missing font glyphs.
    """
    py = top_y + 10
    # Header: RemoteCLI Logo Box
    draw.rounded_rectangle((45, py + 8, 95, py + 58), radius=12, fill='#0066FF')
    # Terminal screen mini icon inside logo
    draw.rectangle((55, py + 20, 85, py + 42), outline='#ffffff', width=2)
    draw.line([(60, py + 46), (80, py + 46)], fill='#ffffff', width=2)
    draw.text((115, py + 16), "RemoteCLI", fill=TEXT_WHITE, font=FONT_TITLE)

    # Header actions: reload, settings, new folder
    draw.rounded_rectangle((WIDTH - 230, py + 8, WIDTH - 180, py + 58), radius=10, fill='#1e293b')
    draw.arc((WIDTH - 215, py + 22, WIDTH - 195, py + 42), start=30, end=310, fill=TEXT_MUTED, width=2)

    draw.rounded_rectangle((WIDTH - 165, py + 8, WIDTH - 115, py + 58), radius=10, fill='#1e293b')
    # Gear icon
    draw.circle((WIDTH - 140, py + 33), 8, outline=TEXT_MUTED, width=2)

    draw.rounded_rectangle((WIDTH - 100, py + 8, WIDTH - 50, py + 58), radius=10, fill='#0066FF')
    draw.text((WIDTH - 85, py + 16), "+", fill='#ffffff', font=FONT_BOLD)

    # Sub-tabs: [Projects] [Conversations] [Metrics]
    tab_y = py + 80
    draw.rounded_rectangle((45, tab_y, 230, tab_y + 54), radius=12, fill='#1e293b', outline='#0066FF', width=2)
    draw.text((70, tab_y + 12), "Projects", fill=TEXT_WHITE, font=FONT_SM)

    draw.rounded_rectangle((250, tab_y, 480, tab_y + 54), radius=12, fill='#111827', outline='#1f2937', width=1)
    draw.text((275, tab_y + 12), "Conversations", fill=TEXT_MUTED, font=FONT_SM)

    # Search Bar
    search_y = tab_y + 75
    draw.rounded_rectangle((45, search_y, WIDTH - 45, search_y + 60), radius=14, fill='#111827', outline='#1f2937', width=1)
    draw.circle((75, search_y + 30), 8, outline='#64748b', width=2)
    draw.line([(81, search_y + 36), (89, search_y + 44)], fill='#64748b', width=2)
    draw.text((105, search_y + 15), "Search projects...", fill='#64748b', font=FONT_REGULAR)

    # Projects List
    projects = [
        ("OTA", "2 sessions", False),
        ("OTA-ext", "4 sessions", False),
        ("teleclaw-sandbox", "2 sessions", False),
        ("Temp", "2 sessions", False),
        ("UAV", "47 sessions", True),  # Climax project with 47 sessions!
    ]

    card_y = search_y + 85
    card_h = 100
    for p_name, p_sess, is_heavy in projects:
        box = (45, card_y, WIDTH - 45, card_y + card_h)
        bg = '#1e1b4b' if is_heavy else '#131b2a'
        border = '#ef4444' if is_heavy else '#1e293b'
        width = 3 if is_heavy else 1

        draw.rounded_rectangle(box, radius=16, fill=bg, outline=border, width=width)

        # Star icon (drawn 5-point star)
        sx, sy = 80, card_y + 48
        draw.polygon([(sx, sy - 14), (sx + 4, sy - 4), (sx + 14, sy - 4), (sx + 6, sy + 3), (sx + 9, sy + 13), (sx, sy + 7), (sx - 9, sy + 13), (sx - 6, sy + 3), (sx - 14, sy - 4), (sx - 4, sy - 4)], outline='#94a3b8', width=1)

        # Project Name & Session count
        draw.text((120, card_y + 18), p_name, fill=TEXT_WHITE, font=FONT_BOLD)
        sess_col = '#f87171' if is_heavy else TEXT_MUTED
        draw.text((120, card_y + 56), p_sess, fill=sess_col, font=FONT_SM)

        # Right buttons: [Delete] [Edit] [>]
        rx = WIDTH - 230
        # Delete red button
        draw.rounded_rectangle((rx, card_y + 22, rx + 52, card_y + 78), radius=10, fill='#450a0a', outline='#ef4444', width=1)
        # Trash can icon
        tx = rx + 16
        draw.rectangle((tx, card_y + 38, tx + 20, card_y + 66), outline='#ef4444', width=2)
        draw.line([(tx - 4, card_y + 36), (tx + 24, card_y + 36)], fill='#ef4444', width=2)

        # Edit blue button
        draw.rounded_rectangle((rx + 65, card_y + 22, rx + 117, card_y + 78), radius=10, fill='#172554', outline='#3b82f6', width=1)
        # Pencil icon
        px = rx + 82
        draw.line([(px, card_y + 60), (px + 16, card_y + 36)], fill='#3b82f6', width=3)

        # Arrow >
        draw.line([(rx + 145, card_y + 40), (rx + 155, card_y + 50), (rx + 145, card_y + 60)], fill=TEXT_MUTED, width=3)

        card_y += card_h + 16

    # Button: + New Session
    btn_y = card_y + 15
    draw.rounded_rectangle((45, btn_y, WIDTH - 45, btn_y + 75), radius=16, fill='#0066FF', outline='#38bdf8', width=2)
    draw.text(((WIDTH - 230) // 2, btn_y + 18), "+ New Session", fill='#ffffff', font=FONT_BOLD)

