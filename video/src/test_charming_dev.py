import math
from PIL import Image, ImageDraw, ImageFont
from spline_art import catmull_rom_spline, draw_smooth_curve

FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 24)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)

INK = '#1e293b'
SKIN = '#ffedd5'
SHIRT = '#38bdf8'
PANTS = '#334155'
SLIPPER = '#facc15'

def draw_hand_drawn_box(draw, box, radius=12, fill='#ffffff', outline=INK, width=4):
    """Draws a soft, slightly wobbly rounded rectangle that looks hand-sketched."""
    x0, y0, x1, y1 = box
    draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, fill=fill, outline=outline, width=width)

def draw_charming_dev(draw, cx, cy, scale=1.0, pose='sitting_tra_da', t=0.0):
    """
    Renders a truly charming, organic doodle dev character with volume and personality.
    pose: 'sitting_tra_da', 'standing_stressed', 'dizzy_slumped'
    """
    breathe = math.sin(t * 3.5) * 4 * scale
    sway = math.cos(t * 2.5) * 3 * scale

    if pose == 'sitting_tra_da':
        # Dev sitting comfortably on a low Vietnamese blue plastic stool
        stool_w, stool_h = 160 * scale, 75 * scale
        stool_y = cy + 110 * scale

        # --- 1. PLASTIC STOOL (Ghế nhựa xanh thấp) ---
        # Stool top seat with rounded corners & center carry-hole
        seat_box = (cx - stool_w/2, stool_y, cx + stool_w/2, stool_y + 26 * scale)
        draw.rounded_rectangle(seat_box, radius=int(8 * scale), fill='#0284c7', outline=INK, width=int(5 * scale))
        # Center oval hole of stool (lỗ cầm ghế)
        draw.ellipse((cx - 18 * scale, stool_y + 8 * scale, cx + 18 * scale, stool_y + 18 * scale), fill='#0369a1', outline=INK, width=int(2 * scale))

        # Stool legs (sturdy splayed plastic legs)
        leg_pts = [
            [(cx - 65 * scale, stool_y + 26 * scale), (cx - 78 * scale, stool_y + stool_h)],
            [(cx - 30 * scale, stool_y + 26 * scale), (cx - 38 * scale, stool_y + stool_h - 5 * scale)],
            [(cx + 30 * scale, stool_y + 26 * scale), (cx + 38 * scale, stool_y + stool_h - 5 * scale)],
            [(cx + 65 * scale, stool_y + 26 * scale), (cx + 78 * scale, stool_y + stool_h)],
        ]
        for lp in leg_pts:
            draw.line(lp, fill=INK, width=int(6 * scale))
            draw.line(lp, fill='#0284c7', width=int(4 * scale))
        # Plastic rib reinforcement ring
        draw.line([(cx - 72 * scale, stool_y + 50 * scale), (cx + 72 * scale, stool_y + 50 * scale)], fill=INK, width=int(5 * scale))
        draw.line([(cx - 72 * scale, stool_y + 50 * scale), (cx + 72 * scale, stool_y + 50 * scale)], fill='#0284c7', width=int(3 * scale))

        # --- 2. HIPS & SHORTS ---
        hip_y = stool_y - 10 * scale + breathe
        shorts_pts = [
            (cx - 55 * scale, hip_y - 25 * scale),
            (cx - 65 * scale, hip_y + 25 * scale),
            (cx - 15 * scale, hip_y + 35 * scale),
            (cx, hip_y + 18 * scale),
            (cx + 15 * scale, hip_y + 35 * scale),
            (cx + 65 * scale, hip_y + 25 * scale),
            (cx + 55 * scale, hip_y - 25 * scale),
        ]
        draw_smooth_curve(draw, shorts_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=PANTS)

        # --- 3. LEGS & HONEYCOMB SLIPPERS (DÉP TỔ ONG) ---
        ground_y = stool_y + stool_h + 10 * scale

        # Left Leg (Resting relaxed facing forward)
        knee_l_x = cx - 35 * scale
        knee_l_y = hip_y + 45 * scale
        foot_l_x = cx - 40 * scale
        foot_l_y = ground_y

        # Thigh left
        draw_smooth_curve(draw, [(cx - 25 * scale, hip_y + 10 * scale), (knee_l_x, knee_l_y)], fill=INK, width=int(22 * scale))
        draw_smooth_curve(draw, [(cx - 25 * scale, hip_y + 10 * scale), (knee_l_x, knee_l_y)], fill=SKIN, width=int(14 * scale))
        # Shin left
        draw_smooth_curve(draw, [(knee_l_x, knee_l_y), (foot_l_x, foot_l_y - 10 * scale)], fill=INK, width=int(20 * scale))
        draw_smooth_curve(draw, [(knee_l_x, knee_l_y), (foot_l_x, foot_l_y - 10 * scale)], fill=SKIN, width=int(12 * scale))
        # Left Dép tổ ong
        draw.rounded_rectangle((foot_l_x - 22 * scale, foot_l_y - 12 * scale, foot_l_x + 22 * scale, foot_l_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK, width=int(4 * scale))
        for hx in [-14, -5, 5, 14]:
            draw.point((foot_l_x + hx * scale, foot_l_y - 2 * scale), fill='#ca8a04')

        # Right Leg (Excited foot tapping: "nhịp giò"!)
        tap = math.sin(t * 14) * 16 * scale
        knee_r_x = cx + 35 * scale
        knee_r_y = hip_y + 45 * scale + tap * 0.3
        foot_r_x = cx + 45 * scale
        foot_r_y = ground_y + tap

        # Thigh right
        draw_smooth_curve(draw, [(cx + 25 * scale, hip_y + 10 * scale), (knee_r_x, knee_r_y)], fill=INK, width=int(22 * scale))
        draw_smooth_curve(draw, [(cx + 25 * scale, hip_y + 10 * scale), (knee_r_x, knee_r_y)], fill=SKIN, width=int(14 * scale))
        # Shin right
        draw_smooth_curve(draw, [(knee_r_x, knee_r_y), (foot_r_x, foot_r_y - 10 * scale)], fill=INK, width=int(20 * scale))
        draw_smooth_curve(draw, [(knee_r_x, knee_r_y), (foot_r_x, foot_r_y - 10 * scale)], fill=SKIN, width=int(12 * scale))
        # Right Dép tổ ong
        draw.rounded_rectangle((foot_r_x - 22 * scale, foot_r_y - 12 * scale, foot_r_x + 24 * scale, foot_r_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK, width=int(4 * scale))
        for hx in [-12, -3, 6, 15]:
            draw.point((foot_r_x + hx * scale, foot_r_y - 2 * scale), fill='#ca8a04')

        # Tap impact shockwaves on ground
        if tap < -4 * scale:
            draw.arc((foot_r_x - 25 * scale, ground_y - 4 * scale, foot_r_x + 30 * scale, ground_y + 18 * scale), start=0, end=180, fill='#94a3b8', width=int(3 * scale))

        # --- 4. TORSO (Comfortable oversized sky-blue t-shirt) ---
        chest_y = hip_y - 120 * scale
        torso_pts = [
            (cx - 45 * scale + sway, chest_y),
            (cx - 58 * scale + sway, chest_y + 60 * scale),
            (cx - 52 * scale + sway, hip_y),
            (cx, hip_y + 8 * scale),
            (cx + 52 * scale + sway, hip_y),
            (cx + 58 * scale + sway, chest_y + 60 * scale),
            (cx + 45 * scale + sway, chest_y),
            (cx + sway, chest_y - 10 * scale),
        ]
        draw_smooth_curve(draw, torso_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=SHIRT)
        # Collar rim
        draw.arc((cx - 18 * scale + sway, chest_y - 16 * scale, cx + 18 * scale + sway, chest_y + 4 * scale), start=0, end=180, fill=INK, width=int(4 * scale))

        # --- 5. HEAD & EXPRESSION ---
        head_cx = cx + sway * 0.8
        head_cy = chest_y - 75 * scale + breathe * 0.5
        head_r = 52 * scale

        # Ears
        draw.ellipse((head_cx - head_r - 6 * scale, head_cy - 8 * scale, head_cx - head_r + 12 * scale, head_cy + 16 * scale), fill=SKIN, outline=INK, width=int(4 * scale))
        draw.ellipse((head_cx + head_r - 12 * scale, head_cy - 8 * scale, head_cx + head_r + 6 * scale, head_cy + 16 * scale), fill=SKIN, outline=INK, width=int(4 * scale))

        # Head base bean
        head_pts = [
            (head_cx - head_r, head_cy),
            (head_cx - head_r + 5 * scale, head_cy - 40 * scale),
            (head_cx, head_cy - 52 * scale),
            (head_cx + head_r - 5 * scale, head_cy - 40 * scale),
            (head_cx + head_r, head_cy),
            (head_cx + head_r - 10 * scale, head_cy + 42 * scale),
            (head_cx, head_cy + 52 * scale),
            (head_cx - head_r + 10 * scale, head_cy + 42 * scale),
        ]
        draw_smooth_curve(draw, head_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=SKIN)

        # Voluminous Messy Dev Hair
        hair_pts = [
            (head_cx - head_r - 8 * scale, head_cy - 10 * scale),
            (head_cx - head_r - 4 * scale, head_cy - 50 * scale),
            (head_cx - 25 * scale, head_cy - 72 * scale),
            (head_cx, head_cy - 75 * scale),
            (head_cx + 30 * scale, head_cy - 70 * scale),
            (head_cx + head_r + 6 * scale, head_cy - 45 * scale),
            (head_cx + head_r + 4 * scale, head_cy - 10 * scale),
            (head_cx + 35 * scale, head_cy - 30 * scale),
            (head_cx + 10 * scale, head_cy - 38 * scale),
            (head_cx - 15 * scale, head_cy - 35 * scale),
            (head_cx - 38 * scale, head_cy - 28 * scale)
        ]
        draw_smooth_curve(draw, hair_pts, fill=INK, width=int(6 * scale), closed=True, fill_color='#1e293b')

        # Cheerful Smiling Eyes (Cute manga curved arcs ^_^)
        # Left eye: smiling upward arc
        draw_smooth_curve(draw, [(head_cx - 28 * scale, head_cy - 4 * scale), (head_cx - 18 * scale, head_cy - 14 * scale), (head_cx - 8 * scale, head_cy - 4 * scale)], fill=INK, width=int(4 * scale))
        # Right eye: smiling upward arc
        draw_smooth_curve(draw, [(head_cx + 8 * scale, head_cy - 4 * scale), (head_cx + 18 * scale, head_cy - 14 * scale), (head_cx + 28 * scale, head_cy - 4 * scale)], fill=INK, width=int(4 * scale))

        # Blushing pink cheeks
        draw.ellipse((head_cx - 38 * scale, head_cy + 6 * scale, head_cx - 16 * scale, head_cy + 22 * scale), fill='#fecdd3')
        draw.ellipse((head_cx + 16 * scale, head_cy + 6 * scale, head_cx + 38 * scale, head_cy + 22 * scale), fill='#fecdd3')

        # Warm Smile
        draw_smooth_curve(draw, [(head_cx - 16 * scale, head_cy + 18 * scale), (head_cx, head_cy + 28 * scale), (head_cx + 16 * scale, head_cy + 18 * scale)], fill='#ef4444', width=int(4 * scale))

        # --- 6. ARMS HOLDING SMARTPHONE ---
        phone_cx = cx + sway
        phone_cy = chest_y + 45 * scale

        # Left Arm: Shoulder -> Elbow -> Hands
        elbow_l = (cx - 62 * scale + sway, chest_y + 35 * scale)
        hand_l = (phone_cx - 28 * scale, phone_cy + 12 * scale)
        draw_smooth_curve(draw, [(cx - 45 * scale + sway, chest_y + 15 * scale), elbow_l, hand_l], fill=INK, width=int(14 * scale))
        draw_smooth_curve(draw, [(cx - 45 * scale + sway, chest_y + 15 * scale), elbow_l, hand_l], fill=SKIN, width=int(9 * scale))

        # Right Arm: Shoulder -> Elbow -> Hands
        elbow_r = (cx + 62 * scale + sway, chest_y + 35 * scale)
        hand_r = (phone_cx + 28 * scale, phone_cy + 12 * scale)
        draw_smooth_curve(draw, [(cx + 45 * scale + sway, chest_y + 15 * scale), elbow_r, hand_r], fill=INK, width=int(14 * scale))
        draw_smooth_curve(draw, [(cx + 45 * scale + sway, chest_y + 15 * scale), elbow_r, hand_r], fill=SKIN, width=int(9 * scale))

        # Realistic Doodle Smartphone (held vertically)
        pw, ph = 54 * scale, 90 * scale
        draw.rounded_rectangle((phone_cx - pw/2, phone_cy - ph/2, phone_cx + pw/2, phone_cy + ph/2), radius=int(8 * scale), fill='#0284c7', outline=INK, width=int(4 * scale))
        # Glowing Screen with chat bubbles inside
        draw.rounded_rectangle((phone_cx - pw/2 + 4 * scale, phone_cy - ph/2 + 5 * scale, phone_cx + pw/2 - 4 * scale, phone_cy + ph/2 - 5 * scale), radius=int(5 * scale), fill='#e0f2fe')
        # Tiny chat bubbles on phone screen
        draw.rounded_rectangle((phone_cx - 18 * scale, phone_cy - 28 * scale, phone_cx + 10 * scale, phone_cy - 14 * scale), radius=int(3 * scale), fill='#38bdf8')
        draw.rounded_rectangle((phone_cx - 10 * scale, phone_cy - 8 * scale, phone_cx + 18 * scale, phone_cy + 6 * scale), radius=int(3 * scale), fill='#22c55e')

        # Thumbs actively tapping on screen!
        tap_l = math.sin(t * 18) * 5 * scale
        tap_r = math.cos(t * 18) * 5 * scale
        draw.ellipse((phone_cx - 24 * scale, phone_cy + tap_l, phone_cx - 8 * scale, phone_cy + 16 * scale + tap_l), fill=SKIN, outline=INK, width=int(3 * scale))
        draw.ellipse((phone_cx + 8 * scale, phone_cy + tap_r, phone_cx + 24 * scale, phone_cy + 16 * scale + tap_r), fill=SKIN, outline=INK, width=int(3 * scale))

        # Floating chat hearts / message pulses rising from phone towards upper right
        for p_i, p_off in enumerate([0.0, 0.5]):
            p_t = (t * 0.8 + p_off) % 1.0
            float_y = p_t * 100 * scale
            float_x = (35 + p_i * 20) * scale + math.sin((t + p_off) * 4) * 10 * scale
            draw.arc((phone_cx + float_x - 10 * scale, phone_cy - 40 * scale - float_y - 10 * scale, phone_cx + float_x + 10 * scale, phone_cy - 40 * scale - float_y + 10 * scale), start=0, end=360, fill='#0284c7', width=int(3 * scale))

def test():
    im = Image.new('RGB', (1080, 1080), (250, 250, 248))
    d = ImageDraw.Draw(im)
    draw_charming_dev(d, 540, 480, scale=1.4, pose='sitting_tra_da', t=1.5)
    im.save('video/test_charming_dev.png')
    print("Saved video/test_charming_dev.png")

if __name__ == '__main__':
    test()
