import math
from PIL import Image, ImageDraw, ImageFont
from spline_art import catmull_rom_spline, draw_smooth_curve

FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 24)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44)

INK = '#1e293b'
SKIN = '#ffedd5'
SHIRT = '#38bdf8'

def draw_chibi_overloaded_dev(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders an expressive chibi doodle dev head with spiral eyes,
    steam puffs shooting from ears, and trembling stress lines.
    """
    shake = math.sin(t * 28) * 3 * scale
    head_cx = cx + shake
    head_cy = cy
    head_r = 55 * scale

    # Steam shooting from ears
    for ear_dir in [-1, 1]:
        ear_x = head_cx + ear_dir * (head_r + 6 * scale)
        for s_i, s_off in enumerate([0.0, 0.5]):
            s_t = (t * 1.6 + s_off) % 1.0
            smk_x = ear_x + ear_dir * (15 + s_t * 50) * scale
            smk_y = head_cy - 12 * scale - s_t * 25 * scale
            draw.ellipse((smk_x - 10 * scale, smk_y - 10 * scale, smk_x + 10 * scale, smk_y + 10 * scale), fill='#f1f5f9', outline='#94a3b8', width=int(2 * scale))

    # Ears
    draw.ellipse((head_cx - head_r - 6 * scale, head_cy - 8 * scale, head_cx - head_r + 12 * scale, head_cy + 16 * scale), fill=SKIN, outline=INK, width=int(3 * scale))
    draw.ellipse((head_cx + head_r - 12 * scale, head_cy - 8 * scale, head_cx + head_r + 6 * scale, head_cy + 16 * scale), fill=SKIN, outline=INK, width=int(3 * scale))

    # Head bean
    draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=SKIN, outline=INK, width=int(4 * scale))

    # Frazzled Messy Hair
    hair_pts = [
        (head_cx - head_r - 8 * scale, head_cy - 15 * scale),
        (head_cx - head_r - 4 * scale, head_cy - 55 * scale),
        (head_cx - 25 * scale, head_cy - 75 * scale),
        (head_cx, head_cy - 80 * scale),
        (head_cx + 28 * scale, head_cy - 75 * scale),
        (head_cx + head_r + 6 * scale, head_cy - 50 * scale),
        (head_cx + head_r + 4 * scale, head_cy - 10 * scale),
        (head_cx + 32 * scale, head_cy - 35 * scale),
        (head_cx + 10 * scale, head_cy - 40 * scale),
        (head_cx - 15 * scale, head_cy - 38 * scale),
        (head_cx - 36 * scale, head_cy - 32 * scale)
    ]
    draw_smooth_curve(draw, hair_pts, fill=INK, width=int(5 * scale), closed=True, fill_color='#1e293b')

    # Stress spikes
    for angle in [-60, -35, -10, 15, 40, 65]:
        rad = math.radians(angle)
        sp_len = 22 * scale + math.sin(t * 22 + angle) * 8 * scale
        draw.line([
            (head_cx + math.sin(rad) * head_r, head_cy - math.cos(rad) * head_r),
            (head_cx + math.sin(rad) * (head_r + sp_len), head_cy - math.cos(rad) * (head_r + sp_len))
        ], fill=INK, width=int(4 * scale))

    # Spiral Eyes (@ @)
    for ex in [head_cx - 20 * scale, head_cx + 20 * scale]:
        spiral_pts = []
        for deg in range(0, 540, 35):
            rad = math.radians(deg + t * 360)
            r = (deg / 540) * 14 * scale
            spiral_pts.append((ex + math.cos(rad) * r, head_cy - 5 * scale + math.sin(rad) * r))
        for sp in range(len(spiral_pts) - 1):
            draw.line([spiral_pts[sp], spiral_pts[sp+1]], fill=INK, width=int(3 * scale))

    # Screaming wobbly mouth
    draw.arc((head_cx - 16 * scale, head_cy + 12 * scale, head_cx + 16 * scale, head_cy + 36 * scale), start=0, end=180, fill='#ef4444', width=int(4 * scale))

    # Sweat beads flying
    sw_y = head_cy - 20 * scale + ((t * 45 * scale) % (45 * scale))
    draw.ellipse((head_cx + 42 * scale, sw_y, head_cx + 54 * scale, sw_y + 14 * scale), fill='#38bdf8', outline=INK, width=int(2 * scale))

def test_scene5():
    im = Image.new('RGB', (1080, 1920), (250, 250, 248))
    draw = ImageDraw.Draw(im)

    # Borders
    draw.rectangle((24, 24, 1080 - 24, 1920 - 24), outline='#cbd5e1', width=3)
    draw.rectangle((20, 20, 1080 - 20, 1920 - 20), outline='#1e293b', width=4)

    # Top Banner
    draw.rounded_rectangle((60, 45, 1080 - 60, 120), radius=16, fill='#ffffff', outline='#0f172a', width=4)
    draw.text((85, 60), "RemoteCLI • Chuyện Nghề Dev", fill='#0f172a', font=FONT_TITLE)

    # Scene 5 Banner
    draw.rounded_rectangle((80, 150, 1080 - 80, 235), radius=18, fill='#fee2e2', outline='#ef4444', width=5)
    draw.text((120, 175), "ĐẦU ÓC PHÂN MẢNH VÌ QUÁ NHIỀU CONTEXT!", fill='#b91c1c', font=FONT_TITLE)

    # Phone Mockup 2 in Center
    phone_2 = Image.open('video/assets/mockups/mockup_phone_2.png').convert('RGBA')
    p_w, p_h = 500, 1040
    p_scaled = phone_2.resize((p_w, p_h), Image.Resampling.LANCZOS)
    p_x = (1080 - p_w) // 2
    p_y = 265
    im.paste(p_scaled, (p_x, p_y), p_scaled)

    # Chibi Overloaded Dev on Upper Left
    draw_chibi_overloaded_dev(draw, 145, 360, scale=1.1, t=2.5)

    # Floating Tags Left
    tags_left = [
        ("90 TIN NHẮN!", 25, 520, '#ef4444', '#fee2e2'),
        ("126K TOKENS!", 25, 680, '#ea580c', '#ffedd5'),
        ("Sửa config.ts?", 25, 840, '#d97706', '#fef3c7'),
    ]
    for text, tx, ty, border_c, bg_c in tags_left:
        tw = len(text) * 16 + 28
        draw.rounded_rectangle((tx, ty, tx + tw, ty + 54), radius=12, fill=bg_c, outline=border_c, width=3)
        draw.text((tx + 14, ty + 12), text, fill=border_c, font=FONT_BOLD)
        # Arrow pointing to phone
        draw.line([(tx + tw, ty + 27), (tx + tw + 25, ty + 27)], fill=border_c, width=3)
        draw.polygon([(tx + tw + 25, ty + 27), (tx + tw + 18, ty + 22), (tx + tw + 18, ty + 32)], fill=border_c)

    # Floating Tags Right
    tags_right = [
        ("Duyệt lệnh bash?", 805, 360, '#0284c7', '#e0f2fe'),
        ("Git conflict!", 815, 520, '#7c3aed', '#ede9fe'),
        ("Xin quyền root?", 805, 680, '#0891b2', '#cffafe'),
        ("47 SESSIONS!", 810, 840, '#dc2626', '#fee2e2'),
    ]
    for text, tx, ty, border_c, bg_c in tags_right:
        tw = len(text) * 16 + 28
        draw.rounded_rectangle((tx, ty, tx + tw, ty + 54), radius=12, fill=bg_c, outline=border_c, width=3)
        draw.text((tx + 14, ty + 12), text, fill=border_c, font=FONT_BOLD)
        # Arrow pointing to phone
        draw.line([(tx - 25, ty + 27), (tx, ty + 27)], fill=border_c, width=3)
        draw.polygon([(tx - 25, ty + 27), (tx - 18, ty + 22), (tx - 18, ty + 32)], fill=border_c)

    # Glowing Circle around "90" unread badge on phone
    badge_x = p_x + 185
    badge_y = p_y + 880
    draw.ellipse((badge_x - 18, badge_y - 18, badge_x + 18, badge_y + 18), outline='#ef4444', width=4)
    for ang in [0, 90, 180, 270]:
        rad = math.radians(ang)
        draw.line([(badge_x + math.cos(rad) * 22, badge_y + math.sin(rad) * 22), (badge_x + math.cos(rad) * 32, badge_y + math.sin(rad) * 32)], fill='#ef4444', width=3)

    # Subtitle Card
    draw.rounded_rectangle((60, 1680, 1080 - 60, 1850), radius=22, fill='#ffffff', outline='#0f172a', width=5)
    draw.text((85, 1760), "Cả đàn AI thi nhau réo xin duyệt quyền...", fill='#0f172a', font=FONT_TITLE)

    im.save('video/preview_scene_5_ideal.png')
    print("Saved video/preview_scene_5_ideal.png")

if __name__ == '__main__':
    test_scene5()
