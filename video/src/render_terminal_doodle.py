import os
import sys
import math
import subprocess
import time
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, 'video/src')
import terminal_ui as tui
import terminal_doodle_scenes as tds
from anim_scenes import draw_chibi_overloaded_dev

FFMPEG = 'C:/Users/tungh/AppData/Local/Programs/Python/Python310/lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe'

WIDTH = 1080
HEIGHT = 1920
FPS = 30
TOTAL_DURATION = 67.0
TOTAL_FRAMES = int(TOTAL_DURATION * FPS)

FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44)
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_SUBTITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 24)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)
FONT_CODE = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 22)
FONT_CODE_BOLD = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)

# Subtitle Segments with highlighted keywords
SUBTITLES = [
    # Scene 1
    (0.0, 4.2, "Có một nghịch lý: AI càng làm được nhiều việc...", "NGHỊCH LÝ"),
    (4.2, 8.8, "...thì ta lại càng bận hơn chứ chẳng được ngồi chơi!", "CÀNG BẬN HƠN"),
    (8.8, 11.5, "Thấy AI cày khỏe, bạn đốt token cho đỡ phí quota...", "ĐỐT TOKEN"),
    (11.5, 14.54, "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", "HITL"),
    # Scene 2
    (14.54, 18.5, "Ngồi máy mãi đau lưng, bạn remote qua điện thoại...", "REMOTE ĐIỆN THOẠI"),
    (18.5, 22.8, "Chat chỉ đạo AI như nhắn tin với người yêu!", "NHƯ NHẮN TIN GHỆ"),
    (22.8, 27.43, "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", "TRÀ ĐÁ VỈA HÈ"),
    # Scene 3
    (27.43, 31.5, "Thấy cái PC ở nhà bỏ không, lôi ra cày ý tưởng cũ...", "HỒI SINH PC"),
    (31.5, 35.8, "Thêm con laptop cũ, thêm một con VPS trên mây...", "LAPTOP + VPS"),
    (35.8, 39.69, "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", "CHUYỂN MÁY 1 TAB"),
    # Scene 4
    (39.69, 43.5, "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", "5-6 PROJECTS"),
    (43.5, 47.68, "Hàng chục session nhảy liên tục từ sáng đến chiều...", "47 SESSIONS"),
    # Scene 5
    (47.68, 51.5, "Và rồi... đầu óc bạn bắt đầu phân mảnh!", "PHÂN MẢNH CONTEXT"),
    (51.5, 55.5, "Cả đàn AI thi nhau réo xin duyệt quyền...", "XIN DUYỆT QUYỀN"),
    (55.5, 58.74, "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", "BẤM RECOMMEND"),
    # Scene 6
    (58.74, 62.5, "Hóa ra từ sáng đến đêm chỉ làm bài thi trắc nghiệm...", "BÀI THI TRẮC NGHIỆM"),
    (62.5, 66.5, "Bạn còn bận hơn cả lúc chưa có AI!", "BẬN HƠN CHƯA CÓ AI"),
]

def get_current_subtitle(t):
    for start, end, text, keyword in SUBTITLES:
        if start <= t < end:
            return text, keyword
    return "", ""

def render_frame(frame_idx):
    t = frame_idx / FPS

    # Canvas Base (Dark app background)
    im = Image.new('RGB', (WIDTH, HEIGHT), '#0f141c')
    draw = ImageDraw.Draw(im)

    # Dynamic device state based on timeline
    cur_tab = 'Home-PC'
    unread_badge = 0
    token_str = '126K'

    if t < 14.54:
        # === SCENE 1: Nghịch Lý AI & HITL Trong Terminal ===
        cur_tab = 'Home-PC'
        unread_badge = 0

        tui.draw_mobile_header(draw, active_tab=cur_tab)
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        # Terminal Window Box
        code_box = (35, 230, WIDTH - 35, 1420)
        draw.rounded_rectangle(code_box, radius=18, fill='#090d16', outline='#1e293b', width=2)

        # Terminal Header Bar
        draw.rounded_rectangle((35, 230, WIDTH - 35, 290), radius=18, fill='#161e2e')
        draw.text((60, 245), ">_ PowerShell Terminal (HITL Active)", fill='#38bdf8', font=FONT_BOLD)
        blink_col = '#22c55e' if math.sin(t * 8) > 0 else '#15803d'
        draw.ellipse((WIDTH - 70, 252, WIDTH - 52, 270), fill=blink_col)

        # Typing Green Code Lines (progressively appearing)
        code_lines = [
            ("$tokenBudget = 1000000; # Max quota burn", '#4ade80'),
            ("while ($true) {", '#4ade80'),
            ("    $task = Invoke-ClaudeAgent -Loop dynamic", '#4ade80'),
            ("    if ($task.NeedsApproval) {", '#facc15'),
            ("        Wait-For-Human-In-The-Loop -Timeout Infinite", '#f87171'),
            ("    }", '#facc15'),
            ("}", '#4ade80')
        ]
        visible_lines = min(len(code_lines), int(t * 1.5) + 2)
        for idx in range(visible_lines):
            cl, ccol = code_lines[idx]
            draw.text((60, 315 + idx * 42), cl, fill=ccol, font=FONT_CODE_BOLD)

        # Animated Blinking Cursor on latest line
        cur_y = 315 + (visible_lines - 1) * 42
        if math.sin(t * 10) > 0:
            draw.rectangle((580, cur_y + 4, 595, cur_y + 26), fill='#4ade80')

        # Left: Frantic typing AI Robot
        tds.draw_dark_robot(draw, 320, 830, scale=1.35, t=t)

        # Right: Stressed Dev scratching head, monitoring HITL
        tds.draw_dark_dev(draw, 780, 840, scale=1.3, pose='standing_stressed', t=t)

        # Dynamic Alerts
        if t >= 4.5:
            st_scale = min(1.0, (t - 4.5) / 0.3)
            st_w = int(600 * st_scale)
            banner_box = ((WIDTH - st_w) // 2, 1150, (WIDTH + st_w) // 2, 1240)
            draw.rounded_rectangle(banner_box, radius=16, fill='#450a0a', outline='#ef4444', width=4)
            if st_scale >= 0.9:
                draw.text(((WIDTH - 540) // 2, 1172), "ĐỐT TOKEN CHO ĐỠ PHÍ QUOTA!", fill='#fca5a5', font=FONT_BOLD)

        if t >= 10.0:
            hitl_y = 1260 + int(math.sin(t * 14) * 4)
            draw.rounded_rectangle((80, hitl_y, WIDTH - 80, hitl_y + 80), radius=16, fill='#7f1d1d', outline='#f87171', width=4)
            draw.text((120, hitl_y + 20), "CHUẨN HITL: PHẢI CANH TỪNG TÝ!", fill='#ffffff', font=FONT_BOLD)

    elif t < 27.43:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        t_scene = t - 14.54
        cur_tab = 'Home-PC'
        unread_badge = 2

        tui.draw_mobile_header(draw, active_tab=cur_tab)
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        # Terminal Chat Background
        chat_box = (35, 230, WIDTH - 35, 1420)
        draw.rounded_rectangle(chat_box, radius=18, fill='#090d16', outline='#1e293b', width=2)

        # Terminal Subheader
        draw.text((60, 245), "Remote Session • QuanTraDa_ViaHe.session", fill='#38bdf8', font=FONT_BOLD)
        draw.line([(35, 290), (WIDTH - 35, 290)], fill='#1e293b', width=2)

        # Chat Bubbles popping up
        if t_scene >= 1.0:
            draw.rounded_rectangle((WIDTH - 580, 320, WIDTH - 60, 400), radius=16, fill='#172554', outline='#3b82f6', width=2)
            draw.text((WIDTH - 550, 340), "Ghé trà đá làm cốc đi anh em ơi!", fill='#93c5fd', font=FONT_SUBTITLE)

        if t_scene >= 3.5:
            draw.rounded_rectangle((60, 420, 640, 500), radius=16, fill='#1e293b', outline='#475569', width=2)
            draw.text((90, 440), "Claude: Em đang cày refactor xong 3 module rồi ạ!", fill='#4ade80', font=FONT_SM)

        if t_scene >= 6.0:
            draw.rounded_rectangle((WIDTH - 640, 520, WIDTH - 60, 600), radius=16, fill='#172554', outline='#3b82f6', width=2)
            draw.text((WIDTH - 610, 540), "Chat AI sướng như nhắn tin với ghệ!", fill='#38bdf8', font=FONT_SUBTITLE)

        # Left: Dev sitting on low plastic stool, tapping phone, foot tapping ("nhịp giò")
        tds.draw_dark_dev(draw, 380, 920, scale=1.4, pose='sitting_tra_da', t=t)

        # Right: Authentic street trà đá table with iced tea, lemon, red straw, and sunflower seeds
        tds.draw_dark_tra_da_table(draw, 780, 920, scale=1.35, t=t)

        # Punchline Badge
        if t_scene >= 8.5:
            punch_box = (80, 1260, WIDTH - 80, 1370)
            draw.rounded_rectangle(punch_box, radius=20, fill='#450a0a', outline='#ef4444', width=5)
            draw.text((120, 1290), "TỰ NHIÊN LẠI GÁNH THÊM VIỆC!", fill='#f87171', font=FONT_HERO)

    elif t < 39.69:
        # === SCENE 3: Hồi Sinh Máy Cũ & Chuyển Máy 1 Tab ===
        t_scene = t - 27.43
        # Animate tab switching: Home-PC -> Laptop -> PC
        if t_scene < 4.0:
            cur_tab = 'Home-PC'
        elif t_scene < 8.0:
            cur_tab = 'Laptop'
        else:
            cur_tab = 'PC'

        unread_badge = 3

        tui.draw_mobile_header(draw, active_tab=cur_tab)
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        # Terminal Body
        term_box = (35, 230, WIDTH - 35, 1420)
        draw.rounded_rectangle(term_box, radius=18, fill='#090d16', outline='#1e293b', width=2)

        # Animated finger tapping between tabs at top!
        if cur_tab == 'Laptop':
            tab_box_lap = (348, 150, 489, 194)
            draw.rounded_rectangle(tab_box_lap, radius=12, outline='#facc15', width=4)
            ripple_r = int((t_scene * 24) % 25)
            draw.circle((418, 172), ripple_r, outline='#38bdf8', width=3)
        elif cur_tab == 'PC':
            tab_box_pc = (507, 150, 584, 194)
            draw.rounded_rectangle(tab_box_pc, radius=12, outline='#facc15', width=4)

        # Multi-Device Ecosystem Doodles inside the terminal!
        tds.draw_dark_ecosystem(draw, 540, 700, scale=1.25, t=t)

        # Big Highlight Sticker
        if t_scene >= 4.0:
            box = (80, 1180, WIDTH - 80, 1300)
            draw.rounded_rectangle(box, radius=20, fill='#172554', outline='#38bdf8', width=6)
            draw.text((120, 1215), "CHUYỂN MÁY CHỈ BẰNG 1 CÁI TAB!", fill='#38bdf8', font=FONT_HERO)

    elif t < 47.68:
        # === SCENE 4: Bùng Nổ Projects (5-6 Projects, 47 Sessions - Image 1 View) ===
        t_scene = t - 39.69
        cur_tab = 'Home-PC'
        unread_badge = 47

        tui.draw_mobile_header(draw, active_tab=cur_tab)
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        # Draw Native Projects List View matching Image 1
        tui.draw_projects_list_view(draw, top_y=220, bottom_y=1420)

        # Danger Alert highlighting UAV project (47 sessions)
        uav_box = (45, 915, WIDTH - 45, 1015)
        pulse_col = '#ef4444' if math.sin(t * 12) > 0 else '#dc2626'
        draw.rounded_rectangle(uav_box, radius=16, outline=pulse_col, width=6)

        # Flashing Banner
        draw.rounded_rectangle((WIDTH - 420, 930, WIDTH - 60, 1000), radius=14, fill='#ef4444')
        draw.text((WIDTH - 400, 946), "HOT: 47 SESSIONS!", fill='#ffffff', font=FONT_BOLD)

        # Floating Project explosion tags with dynamic bobbing
        alert_tags = [
            ("OTA: 2 sess", 60, 520, '#38bdf8'),
            ("OTA-ext: 4 sess", WIDTH - 280, 580, '#facc15'),
            ("teleclaw-sandbox", 60, 720, '#4ade80'),
        ]
        for at_text, at_x, at_y, at_col in alert_tags:
            bob = int(math.sin(t_scene * 5 + at_x) * 6)
            draw.rounded_rectangle((at_x, at_y + bob, at_x + len(at_text) * 16 + 28, at_y + bob + 54), radius=12, fill='#111827', outline=at_col, width=3)
            draw.text((at_x + 14, at_y + bob + 12), at_text, fill=at_col, font=FONT_BOLD)

        # Total Sessions Banner
        if t_scene >= 3.0:
            draw.rounded_rectangle((160, 1260, WIDTH - 160, 1340), radius=16, fill='#7f1d1d', outline='#ef4444', width=4)
            draw.text((200, 1282), "TỔNG CỘNG: 57 SESSIONS ĐANG CHẠY!", fill='#ffffff', font=FONT_BOLD)

    elif t < 58.74:
        # === SCENE 5: Phân Mảnh Context & 90 Tin Nhắn (Image 2 Native View) ===
        t_scene = t - 47.68
        cur_tab = 'Home-PC'
        unread_badge = 90

        tui.draw_mobile_header(draw, active_tab=cur_tab)
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        # Draw Native Active PowerShell Terminal Chat View matching Image 2
        tui.draw_terminal_chat_view(draw, top_y=220, bottom_y=1420)

        # Target Reticle on 90 Unread Messages Badge at bottom
        reticle_x = 232
        reticle_y = 1708
        draw.ellipse((reticle_x - 30, reticle_y - 20, reticle_x + 30, reticle_y + 20), outline='#ef4444', width=4)
        draw.line([(reticle_x - 45, reticle_y), (reticle_x + 45, reticle_y)], fill='#ef4444', width=3)
        draw.line([(reticle_x, reticle_y - 30), (reticle_x, reticle_y + 30)], fill='#ef4444', width=3)

        # Chibi Overloaded Dev with rotating spiral eyes & ear steam
        draw_chibi_overloaded_dev(draw, 880, 420, scale=1.2, t=t)

        # Floating Panic Tags across the code
        tags = [
            ("90 TIN NHẮN!", 45, 820, '#ef4444'),
            ("Xin duyệt quyền?", 45, 940, '#facc15'),
            ("Git conflict!", WIDTH - 270, 820, '#a855f7'),
            ("47 SESSIONS!", WIDTH - 270, 940, '#f87171'),
        ]
        for t_text, tx, ty, tc in tags:
            tw = len(t_text) * 16 + 28
            bob = int(math.sin(t_scene * 6 + tx) * 5)
            draw.rounded_rectangle((tx, ty + bob, tx + tw, ty + bob + 54), radius=12, fill='#111827', outline=tc, width=3)
            draw.text((tx + 14, ty + bob + 12), t_text, fill=tc, font=FONT_BOLD)

        # Anime Flurry Barrage Punching Recommend Button
        tds.draw_dark_flurry_recommend(draw, 540, 1140, scale=1.2, t=t)

        # Warning Sticker
        if t_scene >= 5.0:
            draw.rounded_rectangle((80, 1330, WIDTH - 80, 1410), radius=16, fill='#450a0a', outline='#ef4444', width=4)
            draw.text((120, 1350), "TOÀN NHẮM MẮT BẤM RECOMMEND KHỎI NGHĨ!", fill='#fca5a5', font=FONT_BOLD)

    else:
        # === SCENE 6: Bài Thi Trắc Nghiệm & Cái Kết ===
        t_scene = t - 58.74
        cur_tab = 'Home-PC'
        unread_badge = 90

        tui.draw_mobile_header(draw, active_tab=cur_tab)
        tui.draw_mobile_footer(draw, tokens=token_str, unread_count=unread_badge)

        if t_scene < 4.2:
            # Native Terminal Exam Container
            tds.draw_dark_exam_terminal(draw, 540, 560, scale=1.1, t=t_scene)

            # Rubber Stamp Slam at t_scene >= 2.0s
            if t_scene >= 2.0:
                stamp_box = (WIDTH - 420, 510, WIDTH - 80, 590)
                draw.rounded_rectangle(stamp_box, radius=12, outline='#ef4444', width=5)
                draw.text((WIDTH - 400, 530), "APPROVED - HITL", fill='#ef4444', font=FONT_BOLD)

            # Slumped Dev on ground
            tds.draw_dark_slumped_dev(draw, 540, 1060, scale=1.25, t=t)

            # Card: BẬN HƠN CẢ KHI CHƯA CÓ AI!
            stamp_box = (80, 1260, WIDTH - 80, 1370)
            draw.rounded_rectangle(stamp_box, radius=18, fill='#450a0a', outline='#ef4444', width=5)
            draw.text((130, 1285), "BẬN HƠN CẢ KHI CHƯA CÓ AI!", fill='#fca5a5', font=FONT_HERO)
        else:
            # Final Outro Card
            card_box = (80, 480, WIDTH - 80, 940)
            draw.rounded_rectangle(card_box, radius=24, fill='#111827', outline='#0066FF', width=6)
            draw.text((130, 520), "RemoteCLI • TỔNG KẾT", fill='#38bdf8', font=FONT_HERO)

            draw.text((115, 620), "BẬN HƠN CẢ KHI CHƯA CÓ AI!", fill='#f87171', font=FONT_HERO)
            draw.text((115, 710), "Giải phóng chiếc máy tính của bạn,", fill='#ffffff', font=FONT_TITLE)
            draw.text((115, 770), "nhưng đừng để AI quản lý lại bạn!", fill='#38bdf8', font=FONT_TITLE)

            # Sitting Dev enjoying trà đá peacefully
            tds.draw_dark_dev(draw, 380, 1140, scale=1.3, pose='sitting_tra_da', t=t)
            tds.draw_dark_tra_da_table(draw, 750, 1140, scale=1.25, t=t)

    # ========================================================
    # DYNAMIC SUBTITLE CARD (Floating cleanly above input box)
    # ========================================================
    sub_text, sub_keyword = get_current_subtitle(t)
    if sub_text:
        sub_box = (60, 1440, WIDTH - 60, 1570)
        draw.rounded_rectangle(sub_box, radius=20, fill='#111827', outline='#38bdf8', width=3)
        if sub_keyword:
            kw_w = len(sub_keyword) * 18 + 24
            draw.rounded_rectangle((85, 1455, 85 + kw_w, 1490), radius=8, fill='#1e293b', outline='#facc15', width=2)
            draw.text((95, 1460), sub_keyword, fill='#facc15', font=FONT_SM)
            draw.text((85, 1505), sub_text, fill='#ffffff', font=FONT_TITLE)
        else:
            draw.text((85, 1485), sub_text, fill='#ffffff', font=FONT_TITLE)

    return im

def main():
    out_video = 'video/output/remote-cli-terminal-doodle.mp4'
    soundtrack = 'video/assets/audio/soundtrack_master.wav'

    print(f"Starting terminal doodle video rendering to {out_video}...")
    t_start = time.time()

    cmd = [
        FFMPEG, '-y',
        '-f', 'rawvideo',
        '-vcodec', 'rawvideo',
        '-s', f'{WIDTH}x{HEIGHT}',
        '-pix_fmt', 'rgb24',
        '-r', str(FPS),
        '-i', '-',
        '-i', soundtrack,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '19',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        out_video
    ]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    for frame_idx in range(TOTAL_FRAMES):
        frame_img = render_frame(frame_idx)
        proc.stdin.write(frame_img.tobytes())

        if (frame_idx + 1) % 150 == 0 or frame_idx == TOTAL_FRAMES - 1:
            elapsed = time.time() - t_start
            fps_speed = (frame_idx + 1) / elapsed
            percent = (frame_idx + 1) / TOTAL_FRAMES * 100
            print(f"Rendered {frame_idx + 1}/{TOTAL_FRAMES} frames ({percent:.1f}%) - Speed: {fps_speed:.1f} fps")

    proc.stdin.close()
    stderr = proc.stderr.read()
    proc.wait()

    total_time = time.time() - t_start
    if proc.returncode == 0:
        file_size = os.path.getsize(out_video) / (1024 * 1024)
        print(f"SUCCESS: Rendered {out_video} ({file_size:.2f} MB) in {total_time:.1f}s")
    else:
        print(f"ERROR rendering video. Return code: {proc.returncode}")
        print(stderr.decode('utf-8', errors='ignore'))

if __name__ == '__main__':
    main()
