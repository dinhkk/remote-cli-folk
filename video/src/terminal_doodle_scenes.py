import math
import random
import os
import sys

# Ensure video/src is on sys.path
CUR_DIR = os.path.dirname(os.path.abspath(__file__))
if CUR_DIR not in sys.path:
    sys.path.insert(0, CUR_DIR)

from PIL import Image, ImageDraw, ImageFont
from spline_art import catmull_rom_spline, draw_smooth_curve

# Monospace Terminal Fonts (Consolas)
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 38)
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 30)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)
FONT_SUBTITLE = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 22)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 22)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 20)
FONT_XS = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 16)
FONT_CODE = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 22)
FONT_CODE_BOLD = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)

# Dark Theme Chalk / Ink Palette
INK_WHITE = '#ffffff'
INK_DARK = '#0f172a'
SKIN = '#fed7aa'
SHIRT = '#38bdf8'
PANTS = '#475569'
SLIPPER = '#facc15'
STOOL = '#0284c7'
GLOW_CYAN = '#38bdf8'
GLOW_GREEN = '#4ade80'
GLOW_YELLOW = '#facc15'
GLOW_RED = '#f87171'

def draw_dark_dev(draw, cx, cy, scale=1.0, pose='sitting_tra_da', t=0.0):
    """
    Renders the dev character with crisp chalk-white outlines and vibrant fills
    for maximum contrast and charm on dark terminal backgrounds.
    """
    breathe = math.sin(t * 3.5) * 4 * scale
    sway = math.cos(t * 2.5) * 3 * scale

    if pose in ('sitting', 'sitting_tra_da'):
        # --- SITTING ON BLUE PLASTIC STOOL ---
        stool_w, stool_h = 160 * scale, 75 * scale
        stool_y = cy + 110 * scale

        # Stool Seat
        seat_box = (cx - stool_w/2, stool_y, cx + stool_w/2, stool_y + 26 * scale)
        draw.rounded_rectangle(seat_box, radius=int(8 * scale), fill=STOOL, outline=INK_WHITE, width=int(3 * scale))
        draw.ellipse((cx - 18 * scale, stool_y + 8 * scale, cx + 18 * scale, stool_y + 18 * scale), fill='#0369a1', outline=INK_WHITE, width=int(2 * scale))

        # Stool Legs
        leg_pts = [
            [(cx - 65 * scale, stool_y + 26 * scale), (cx - 78 * scale, stool_y + stool_h)],
            [(cx - 30 * scale, stool_y + 26 * scale), (cx - 38 * scale, stool_y + stool_h - 5 * scale)],
            [(cx + 30 * scale, stool_y + 26 * scale), (cx + 38 * scale, stool_y + stool_h - 5 * scale)],
            [(cx + 65 * scale, stool_y + 26 * scale), (cx + 78 * scale, stool_y + stool_h)],
        ]
        for lp in leg_pts:
            draw.line(lp, fill=INK_WHITE, width=int(5 * scale))
            draw.line(lp, fill=STOOL, width=int(3 * scale))
        draw.line([(cx - 72 * scale, stool_y + 50 * scale), (cx + 72 * scale, stool_y + 50 * scale)], fill=INK_WHITE, width=int(3 * scale))

        # Hips & Shorts
        hip_y = stool_y - 10 * scale + breathe
        shorts_pts = [
            (cx - 55 * scale, hip_y - 25 * scale),
            (cx - 65 * scale, hip_y + 25 * scale),
            (cx - 15 * scale, hip_y + 35 * scale),
            (cx, hip_y + 18 * scale),
            (cx + 15 * scale, hip_y + 35 * scale),
            (cx + 65 * scale, hip_y + 25 * scale),
            (cx - 55 * scale, hip_y - 25 * scale),
        ]
        draw_smooth_curve(draw, shorts_pts, fill=INK_WHITE, width=int(4 * scale), closed=True, fill_color=PANTS)

        # Legs & Honeycomb Slippers
        ground_y = stool_y + stool_h + 10 * scale

        # Left Leg (resting)
        knee_l_x = cx - 45 * scale
        knee_l_y = hip_y + 45 * scale
        foot_l_x = cx - 50 * scale
        foot_l_y = ground_y

        draw_smooth_curve(draw, [(cx - 30 * scale, hip_y + 10 * scale), (knee_l_x, knee_l_y), (foot_l_x, foot_l_y - 10 * scale)], fill=INK_WHITE, width=int(20 * scale))
        draw_smooth_curve(draw, [(cx - 30 * scale, hip_y + 10 * scale), (knee_l_x, knee_l_y), (foot_l_x, foot_l_y - 10 * scale)], fill=SKIN, width=int(14 * scale))

        draw.rounded_rectangle((foot_l_x - 22 * scale, foot_l_y - 12 * scale, foot_l_x + 22 * scale, foot_l_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK_WHITE, width=int(3 * scale))
        for hx in [-14, -5, 5, 14]:
            draw.point((foot_l_x + hx * scale, foot_l_y - 2 * scale), fill='#ca8a04')

        # Right Leg (Excited foot tapping: "nhịp giò"!)
        tap = math.sin(t * 14) * 16 * scale
        knee_r_x = cx + 45 * scale
        knee_r_y = hip_y + 45 * scale + tap * 0.3
        foot_r_x = cx + 55 * scale
        foot_r_y = ground_y + tap

        draw_smooth_curve(draw, [(cx + 30 * scale, hip_y + 10 * scale), (knee_r_x, knee_r_y), (foot_r_x, foot_r_y - 10 * scale)], fill=INK_WHITE, width=int(20 * scale))
        draw_smooth_curve(draw, [(cx + 30 * scale, hip_y + 10 * scale), (knee_r_x, knee_r_y), (foot_r_x, foot_r_y - 10 * scale)], fill=SKIN, width=int(14 * scale))

        draw.rounded_rectangle((foot_r_x - 22 * scale, foot_r_y - 12 * scale, foot_r_x + 24 * scale, foot_r_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK_WHITE, width=int(3 * scale))
        for hx in [-12, -3, 6, 15]:
            draw.point((foot_r_x + hx * scale, foot_r_y - 2 * scale), fill='#ca8a04')

        # Foot tapping ground ripple shockwave
        if tap < -4 * scale:
            draw.arc((foot_r_x - 25 * scale, ground_y - 4 * scale, foot_r_x + 30 * scale, ground_y + 18 * scale), start=0, end=180, fill=GLOW_CYAN, width=int(3 * scale))

        # Torso
        chest_y = hip_y - 120 * scale
        torso_pts = [
            (cx - 45 * scale + sway, chest_y),
            (cx + 45 * scale + sway, chest_y),
            (cx + 52 * scale, hip_y - 10 * scale),
            (cx - 52 * scale, hip_y - 10 * scale),
            (cx - 45 * scale + sway, chest_y)
        ]
        draw_smooth_curve(draw, torso_pts, fill=INK_WHITE, width=int(4 * scale), closed=True, fill_color=SHIRT)

        # Arms holding phone
        phone_tilt = math.sin(t * 6) * 3
        phone_cx = cx + 8 * scale + sway
        phone_cy = chest_y + 55 * scale + breathe

        # Left & Right Arms
        draw_smooth_curve(draw, [(cx - 42 * scale + sway, chest_y + 15 * scale), (cx - 55 * scale, phone_cy + 25 * scale), (phone_cx - 24 * scale, phone_cy)], fill=INK_WHITE, width=int(18 * scale))
        draw_smooth_curve(draw, [(cx - 42 * scale + sway, chest_y + 15 * scale), (cx - 55 * scale, phone_cy + 25 * scale), (phone_cx - 24 * scale, phone_cy)], fill=SHIRT, width=int(12 * scale))

        draw_smooth_curve(draw, [(cx + 42 * scale + sway, chest_y + 15 * scale), (cx + 55 * scale, phone_cy + 25 * scale), (phone_cx + 24 * scale, phone_cy)], fill=INK_WHITE, width=int(18 * scale))
        draw_smooth_curve(draw, [(cx + 42 * scale + sway, chest_y + 15 * scale), (cx + 55 * scale, phone_cy + 25 * scale), (phone_cx + 24 * scale, phone_cy)], fill=SHIRT, width=int(12 * scale))

        # Mobile Phone
        p_w, p_h = 42 * scale, 75 * scale
        phone_box = (phone_cx - p_w/2, phone_cy - p_h/2, phone_cx + p_w/2, phone_cy + p_h/2)
        draw.rounded_rectangle(phone_box, radius=int(6 * scale), fill='#111827', outline=INK_WHITE, width=int(3 * scale))
        draw.rectangle((phone_cx - p_w/2 + 4 * scale, phone_cy - p_h/2 + 8 * scale, phone_cx + p_w/2 - 4 * scale, phone_cy + p_h/2 - 8 * scale), fill='#0284c7')

        # Thumbs tapping rapidly on phone screen!
        th_l = math.sin(t * 18) * 4 * scale
        th_r = math.cos(t * 18) * 4 * scale
        draw.ellipse((phone_cx - 16 * scale, phone_cy - 10 * scale + th_l, phone_cx - 4 * scale, phone_cy + 6 * scale + th_l), fill=SKIN, outline=INK_WHITE, width=int(2 * scale))
        draw.ellipse((phone_cx + 4 * scale, phone_cy - 10 * scale + th_r, phone_cx + 16 * scale, phone_cy + 6 * scale + th_r), fill=SKIN, outline=INK_WHITE, width=int(2 * scale))

        # Floating chat sparks / hearts rising from phone
        for s_idx, s_seed in enumerate([0.0, 0.4, 0.8]):
            s_t = (t * 1.5 + s_seed) % 1.0
            sp_x = phone_cx + math.sin(s_t * 6 + s_idx) * 22 * scale
            sp_y = (phone_cy - p_h/2) - s_t * 55 * scale
            sp_r = int((1.0 - s_t) * 7 * scale)
            if sp_r > 1:
                draw.ellipse((sp_x - sp_r, sp_y - sp_r, sp_x + sp_r, sp_y + sp_r), fill=GLOW_GREEN, outline=INK_WHITE, width=1)

        # Head & Face
        head_cx = cx + sway
        head_cy = chest_y - 58 * scale
        head_r = 48 * scale

        # Ears
        draw.ellipse((head_cx - head_r - 6 * scale, head_cy - 6 * scale, head_cx - head_r + 10 * scale, head_cy + 14 * scale), fill=SKIN, outline=INK_WHITE, width=int(2 * scale))
        draw.ellipse((head_cx + head_r - 10 * scale, head_cy - 6 * scale, head_cx + head_r + 6 * scale, head_cy + 14 * scale), fill=SKIN, outline=INK_WHITE, width=int(2 * scale))

        # Head Base
        draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=SKIN, outline=INK_WHITE, width=int(3 * scale))

        # Tousled Hair
        hair_pts = [
            (head_cx - head_r - 4 * scale, head_cy - 10 * scale),
            (head_cx - head_r, head_cy - 45 * scale),
            (head_cx - 20 * scale, head_cy - 65 * scale),
            (head_cx + 5 * scale, head_cy - 70 * scale),
            (head_cx + 25 * scale, head_cy - 62 * scale),
            (head_cx + head_r, head_cy - 40 * scale),
            (head_cx + head_r + 2 * scale, head_cy - 5 * scale),
            (head_cx + 25 * scale, head_cy - 25 * scale),
            (head_cx + 8 * scale, head_cy - 30 * scale),
            (head_cx - 15 * scale, head_cy - 28 * scale),
            (head_cx - 30 * scale, head_cy - 22 * scale)
        ]
        draw_smooth_curve(draw, hair_pts, fill=INK_WHITE, width=int(4 * scale), closed=True, fill_color='#1e293b')

        # Happy, relaxed chat eyes (^ _ ^)
        draw.arc((head_cx - 26 * scale, head_cy - 14 * scale, head_cx - 8 * scale, head_cy + 4 * scale), start=180, end=360, fill=INK_DARK, width=int(3 * scale))
        draw.arc((head_cx + 8 * scale, head_cy - 14 * scale, head_cx + 26 * scale, head_cy + 4 * scale), start=180, end=360, fill=INK_DARK, width=int(3 * scale))

        # Rosy Cheeks
        draw.ellipse((head_cx - 34 * scale, head_cy + 2 * scale, head_cx - 20 * scale, head_cy + 12 * scale), fill='#fca5a5')
        draw.ellipse((head_cx + 20 * scale, head_cy + 2 * scale, head_cx + 34 * scale, head_cy + 12 * scale), fill='#fca5a5')

        # Smiling mouth
        draw.arc((head_cx - 14 * scale, head_cy + 8 * scale, head_cx + 14 * scale, head_cy + 28 * scale), start=0, end=180, fill='#ef4444', width=int(3 * scale))

    elif pose == 'standing_stressed':
        # --- STRESSED DEV MONITORING HITL ---
        tremor = math.sin(t * 30) * 3 * scale
        ground_y = cy + 180 * scale

        # Knocking knees with shorts and skin calves
        knee_knock = math.sin(t * 22) * 6 * scale
        knee_l_x = cx - 35 * scale + knee_knock
        knee_r_x = cx + 35 * scale - knee_knock

        # Shorts (upper leg)
        draw.line([(cx - 28 * scale, cy + 25 * scale), (knee_l_x, cy + 85 * scale)], fill=INK_WHITE, width=int(26 * scale))
        draw.line([(cx - 28 * scale, cy + 25 * scale), (knee_l_x, cy + 85 * scale)], fill=PANTS, width=int(20 * scale))

        draw.line([(cx + 28 * scale, cy + 25 * scale), (knee_r_x, cy + 85 * scale)], fill=INK_WHITE, width=int(26 * scale))
        draw.line([(cx + 28 * scale, cy + 25 * scale), (knee_r_x, cy + 85 * scale)], fill=PANTS, width=int(20 * scale))

        # Calves (skin)
        draw.line([(knee_l_x, cy + 85 * scale), (cx - 45 * scale, ground_y - 10 * scale)], fill=INK_WHITE, width=int(18 * scale))
        draw.line([(knee_l_x, cy + 85 * scale), (cx - 45 * scale, ground_y - 10 * scale)], fill=SKIN, width=int(12 * scale))

        draw.line([(knee_r_x, cy + 85 * scale), (cx + 45 * scale, ground_y - 10 * scale)], fill=INK_WHITE, width=int(18 * scale))
        draw.line([(knee_r_x, cy + 85 * scale), (cx + 45 * scale, ground_y - 10 * scale)], fill=SKIN, width=int(12 * scale))

        # Honeycomb Slippers
        for fx in [cx - 45 * scale, cx + 45 * scale]:
            draw.rounded_rectangle((fx - 22 * scale, ground_y - 12 * scale, fx + 24 * scale, ground_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK_WHITE, width=int(3 * scale))
            for hx in [-12, -3, 6, 15]:
                draw.point((fx + hx * scale, ground_y - 2 * scale), fill='#ca8a04')

        # Torso
        torso_pts = [
            (cx - 48 * scale + tremor, cy - 80 * scale),
            (cx + 48 * scale + tremor, cy - 80 * scale),
            (cx + 40 * scale, cy + 30 * scale),
            (cx - 40 * scale, cy + 30 * scale),
            (cx - 48 * scale + tremor, cy - 80 * scale)
        ]
        draw_smooth_curve(draw, torso_pts, fill=INK_WHITE, width=int(4 * scale), closed=True, fill_color=SHIRT)

        # Head & Stressed Face
        head_cx = cx + tremor
        head_cy = cy - 135 * scale
        head_r = 48 * scale

        # Left Arm: scratching head
        draw_smooth_curve(draw, [(cx - 45 * scale, cy - 70 * scale), (cx - 75 * scale, cy - 110 * scale), (head_cx - 25 * scale, head_cy - 45 * scale)], fill=INK_WHITE, width=int(18 * scale))
        draw_smooth_curve(draw, [(cx - 45 * scale, cy - 70 * scale), (cx - 75 * scale, cy - 110 * scale), (head_cx - 25 * scale, head_cy - 45 * scale)], fill=SHIRT, width=int(12 * scale))

        # Right Arm: clutching temple in distress
        draw_smooth_curve(draw, [(cx + 45 * scale, cy - 70 * scale), (cx + 75 * scale, cy - 110 * scale), (head_cx + 42 * scale, head_cy - 10 * scale)], fill=INK_WHITE, width=int(18 * scale))
        draw_smooth_curve(draw, [(cx + 45 * scale, cy - 70 * scale), (cx + 75 * scale, cy - 110 * scale), (head_cx + 42 * scale, head_cy - 10 * scale)], fill=SHIRT, width=int(12 * scale))

        # Hand beans
        draw.ellipse((head_cx - 35 * scale, head_cy - 55 * scale, head_cx - 15 * scale, head_cy - 35 * scale), fill=SKIN, outline=INK_WHITE, width=int(2 * scale))
        draw.ellipse((head_cx + 35 * scale, head_cy - 20 * scale, head_cx + 52 * scale, head_cy), fill=SKIN, outline=INK_WHITE, width=int(2 * scale))

        # Head Base
        draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=SKIN, outline=INK_WHITE, width=int(3 * scale))

        # Disheveled Hair with stress spikes
        hair_pts = [
            (head_cx - head_r - 4 * scale, head_cy - 10 * scale),
            (head_cx - head_r, head_cy - 50 * scale),
            (head_cx - 20 * scale, head_cy - 75 * scale),
            (head_cx + 5 * scale, head_cy - 80 * scale),
            (head_cx + 25 * scale, head_cy - 72 * scale),
            (head_cx + head_r + 2 * scale, head_cy - 45 * scale),
            (head_cx + head_r + 2 * scale, head_cy - 5 * scale),
            (head_cx + 25 * scale, head_cy - 25 * scale),
            (head_cx + 8 * scale, head_cy - 30 * scale),
            (head_cx - 15 * scale, head_cy - 28 * scale),
            (head_cx - 30 * scale, head_cy - 22 * scale)
        ]
        draw_smooth_curve(draw, hair_pts, fill=INK_WHITE, width=int(4 * scale), closed=True, fill_color='#1e293b')

        # Stress spikes shooting from head
        for angle in [-45, -15, 15, 45]:
            rad = math.radians(angle)
            sp_len = 22 * scale + math.sin(t * 22 + angle) * 8 * scale
            draw.line([
                (head_cx + math.sin(rad) * head_r, head_cy - math.cos(rad) * head_r),
                (head_cx + math.sin(rad) * (head_r + sp_len), head_cy - math.cos(rad) * (head_r + sp_len))
            ], fill=GLOW_RED, width=int(3 * scale))

        # Wide anxious eyes with shaking pupils
        eye_shake = math.sin(t * 35) * 2 * scale
        for ex in [head_cx - 18 * scale, head_cx + 18 * scale]:
            draw.ellipse((ex - 12 * scale, head_cy - 16 * scale, ex + 12 * scale, head_cy + 8 * scale), fill='#ffffff', outline=INK_WHITE, width=int(2 * scale))
            draw.ellipse((ex - 4 * scale + eye_shake, head_cy - 6 * scale, ex + 4 * scale + eye_shake, head_cy + 2 * scale), fill=INK_DARK)

        # Wobbly screaming mouth
        draw.arc((head_cx - 16 * scale, head_cy + 10 * scale, head_cx + 16 * scale, head_cy + 34 * scale), start=0, end=180, fill=GLOW_RED, width=int(3 * scale))

        # Sweat droplets flying
        sw_y = head_cy - 25 * scale + ((t * 45 * scale) % (50 * scale))
        draw.ellipse((head_cx + 40 * scale, sw_y, head_cx + 52 * scale, sw_y + 16 * scale), fill=GLOW_CYAN, outline=INK_WHITE, width=int(2 * scale))

def draw_dark_robot(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders the hyperactive AI robot furiously typing commands inside the dark terminal.
    """
    hop = math.sin(t * 16) * 6 * scale
    ry = cy + hop

    # Glowing Antenna with sparks
    ant_top = ry - 145 * scale
    draw.line([(cx, ry - 100 * scale), (cx, ant_top)], fill=INK_WHITE, width=int(4 * scale))
    draw.ellipse((cx - 10 * scale, ant_top - 10 * scale, cx + 10 * scale, ant_top + 10 * scale), fill=GLOW_YELLOW, outline=INK_WHITE, width=int(2 * scale))

    # Lightning arcs from antenna
    spark_rad = (t * 24) % (2 * math.pi)
    sp_x = cx + math.cos(spark_rad) * 22 * scale
    sp_y = ant_top + math.sin(spark_rad) * 22 * scale
    draw.line([(cx, ant_top), (sp_x, sp_y)], fill=GLOW_YELLOW, width=int(3 * scale))

    # Robot Head Box
    head_box = (cx - 65 * scale, ry - 100 * scale, cx + 65 * scale, ry - 20 * scale)
    draw.rounded_rectangle(head_box, radius=int(14 * scale), fill='#1e293b', outline=INK_WHITE, width=int(3 * scale))

    # Glowing Matrix Visor
    draw.rounded_rectangle((cx - 52 * scale, ry - 88 * scale, cx + 52 * scale, ry - 42 * scale), radius=int(8 * scale), fill='#090d16', outline=GLOW_GREEN, width=int(2 * scale))

    # Glowing Matrix Eye Slots
    for ex in [cx - 26 * scale, cx + 26 * scale]:
        blink = math.sin(t * 12) > 0.8
        if blink:
            draw.line([(ex - 12 * scale, ry - 65 * scale), (ex + 12 * scale, ry - 65 * scale)], fill=GLOW_GREEN, width=int(4 * scale))
        else:
            draw.rounded_rectangle((ex - 12 * scale, ry - 75 * scale, ex + 12 * scale, ry - 55 * scale), radius=int(4 * scale), fill=GLOW_GREEN)

    # Robot Torso
    body_box = (cx - 75 * scale, ry - 10 * scale, cx + 75 * scale, ry + 95 * scale)
    draw.rounded_rectangle(body_box, radius=int(18 * scale), fill='#1e293b', outline=INK_WHITE, width=int(4 * scale))

    # Chest Token Meter Screen
    draw.rounded_rectangle((cx - 55 * scale, ry + 8 * scale, cx + 55 * scale, ry + 65 * scale), radius=int(8 * scale), fill='#090d16', outline='#334155', width=int(2 * scale))
    draw.text((cx - 42 * scale, ry + 16 * scale), "TOKENS", fill=GLOW_YELLOW, font=FONT_XS)

    # Rapid animated counter
    tok_count = int(126000 + (t * 8500) % 50000)
    draw.text((cx - 45 * scale, ry + 36 * scale), f"{tok_count:,}", fill=GLOW_GREEN, font=FONT_SM)

    # Robot Arms Typing Frenzy
    left_hand_y = ry + 105 * scale + math.sin(t * 22) * 15 * scale
    right_hand_y = ry + 105 * scale + math.cos(t * 22) * 15 * scale

    draw_smooth_curve(draw, [(cx - 70 * scale, ry + 15 * scale), (cx - 105 * scale, ry + 65 * scale), (cx - 60 * scale, left_hand_y)], fill=INK_WHITE, width=int(14 * scale))
    draw_smooth_curve(draw, [(cx - 70 * scale, ry + 15 * scale), (cx - 105 * scale, ry + 65 * scale), (cx - 60 * scale, left_hand_y)], fill=GLOW_CYAN, width=int(8 * scale))

    draw_smooth_curve(draw, [(cx + 70 * scale, ry + 15 * scale), (cx + 105 * scale, ry + 65 * scale), (cx + 60 * scale, right_hand_y)], fill=INK_WHITE, width=int(14 * scale))
    draw_smooth_curve(draw, [(cx + 70 * scale, ry + 15 * scale), (cx + 105 * scale, ry + 65 * scale), (cx + 60 * scale, right_hand_y)], fill=GLOW_CYAN, width=int(8 * scale))

    # Metallic Claws
    draw.ellipse((cx - 72 * scale, left_hand_y - 12 * scale, cx - 48 * scale, left_hand_y + 12 * scale), fill=GLOW_YELLOW, outline=INK_WHITE, width=int(2 * scale))
    draw.ellipse((cx + 48 * scale, right_hand_y - 12 * scale, cx + 72 * scale, right_hand_y + 12 * scale), fill=GLOW_YELLOW, outline=INK_WHITE, width=int(2 * scale))

    # Keyboard underneath with code typing sparks
    kb_y = ry + 125 * scale
    draw.rounded_rectangle((cx - 110 * scale, kb_y, cx + 110 * scale, kb_y + 35 * scale), radius=int(6 * scale), fill='#111827', outline=INK_WHITE, width=int(2 * scale))
    for k in range(8):
        kx = cx - 95 * scale + k * 26 * scale
        draw.rectangle((kx, kb_y + 6 * scale, kx + 18 * scale, kb_y + 26 * scale), fill='#1e293b', outline='#475569', width=1)

    # Sparks flying from keyboard keys
    spk_x = cx + math.sin(t * 30) * 60 * scale
    draw.line([(spk_x, kb_y), (spk_x + 10 * scale, kb_y - 20 * scale)], fill=GLOW_YELLOW, width=int(3 * scale))
    draw.line([(spk_x, kb_y), (spk_x - 12 * scale, kb_y - 18 * scale)], fill=GLOW_CYAN, width=int(3 * scale))

def draw_dark_tra_da_table(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders authentic Vietnamese street trà đá crate table on the dark terminal surface.
    """
    tbl_w, tbl_h = 180 * scale, 100 * scale
    ty = cy + 50 * scale

    # Upside-down beer crate / plastic table
    draw.rounded_rectangle((cx - tbl_w/2, ty, cx + tbl_w/2, ty + tbl_h), radius=int(10 * scale), fill='#064e3b', outline=INK_WHITE, width=int(3 * scale))

    # Crate cutouts / lattice pattern
    for ci in range(3):
        hx = cx - 55 * scale + ci * 55 * scale
        draw.rounded_rectangle((hx - 18 * scale, ty + 25 * scale, hx + 18 * scale, ty + 75 * scale), radius=int(6 * scale), fill='#022c22', outline=INK_WHITE, width=int(2 * scale))

    # Tabletop Surface
    draw.rounded_rectangle((cx - tbl_w/2 - 10 * scale, ty - 12 * scale, cx + tbl_w/2 + 10 * scale, ty + 6 * scale), radius=int(6 * scale), fill='#047857', outline=INK_WHITE, width=int(3 * scale))

    # Tall Glass of Iced Tea (Cốc Trà Đá)
    gx = cx - 30 * scale
    gy = ty - 85 * scale
    gw, gh = 48 * scale, 82 * scale

    # Glass polygon with slight taper
    glass_pts = [
        (gx - gw/2 + 4 * scale, gy),
        (gx + gw/2 - 4 * scale, gy),
        (gx + gw/2 - 8 * scale, gy + gh),
        (gx - gw/2 + 8 * scale, gy + gh),
    ]
    draw.polygon(glass_pts, fill='#0284c7') # cold glass tint
    draw.polygon([
        (gx - gw/2 + 6 * scale, gy + 15 * scale),
        (gx + gw/2 - 6 * scale, gy + 15 * scale),
        (gx + gw/2 - 8 * scale, gy + gh - 4 * scale),
        (gx - gw/2 + 8 * scale, gy + gh - 4 * scale),
    ], fill='#ca8a04') # Golden iced tea liquid

    # Ice Cubes floating
    draw.rounded_rectangle((gx - 14 * scale, gy + 22 * scale, gx + 6 * scale, gy + 42 * scale), radius=int(4 * scale), fill='#ffffff', outline='#38bdf8', width=int(2 * scale))
    draw.rounded_rectangle((gx - 4 * scale, gy + 42 * scale, gx + 16 * scale, gy + 62 * scale), radius=int(4 * scale), fill='#ffffff', outline='#38bdf8', width=int(2 * scale))

    # Glass Outline
    for i in range(len(glass_pts)):
        p1 = glass_pts[i]
        p2 = glass_pts[(i + 1) % len(glass_pts)]
        draw.line([p1, p2], fill=INK_WHITE, width=int(3 * scale))

    # Red Straw sticking out
    straw_top = (gx + 18 * scale, gy - 35 * scale)
    draw.line([(gx + 4 * scale, gy + 30 * scale), (gx + 12 * scale, gy), straw_top], fill='#ef4444', width=int(5 * scale))
    draw.line([(gx + 4 * scale, gy + 30 * scale), (gx + 12 * scale, gy), straw_top], fill='#ffffff', width=int(1 * scale))

    # Cold Vapor Curling Up into the Terminal
    for vi in range(2):
        vt = (t * 1.4 + vi * 0.5) % 1.0
        vy = gy - 15 * scale - vt * 65 * scale
        vx = gx + math.sin(vt * 6 + vi) * 14 * scale
        vr = int(4 * scale + vt * 8 * scale)
        draw.ellipse((vx - vr, vy - vr, vx + vr, vy + vr), fill='#e2e8f0', outline=GLOW_CYAN, width=1)

    # Plate of Sunflower Seeds (Đĩa Hướng Dương)
    px = cx + 45 * scale
    py = ty - 18 * scale
    draw.ellipse((px - 32 * scale, py - 10 * scale, px + 32 * scale, py + 10 * scale), fill='#f8fafc', outline=INK_WHITE, width=int(2 * scale))
    # Seeds
    for s_ang in [0, 45, 90, 135, 180, 225, 270, 315]:
        s_rad = math.radians(s_ang)
        sx = px + math.cos(s_rad) * 14 * scale
        sy = py + math.sin(s_rad) * 4 * scale
        draw.ellipse((sx - 4 * scale, sy - 2 * scale, sx + 4 * scale, sy + 2 * scale), fill='#475569', outline=INK_WHITE, width=1)

def draw_dark_ecosystem(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders PC, Laptop, and Cloud VPS with neon cables connecting directly
    to the active terminal tab switcher at the top.
    """
    # 1. Left: Bulky Dust-Covered CRT PC (Home-PC)
    pc_x = cx - 290 * scale
    pc_y = cy + 40 * scale

    # CRT Monitor
    draw.rounded_rectangle((pc_x - 105 * scale, pc_y - 85 * scale, pc_x + 105 * scale, pc_y + 55 * scale), radius=int(16 * scale), fill='#1e293b', outline=INK_WHITE, width=int(4 * scale))
    draw.rounded_rectangle((pc_x - 85 * scale, pc_y - 70 * scale, pc_x + 85 * scale, pc_y + 40 * scale), radius=int(10 * scale), fill='#090d16', outline=GLOW_GREEN, width=int(3 * scale))

    # CRT Scanlines & Terminal text
    draw.text((pc_x - 72 * scale, pc_y - 58 * scale), "> Home-PC", fill=GLOW_GREEN, font=FONT_SM)
    draw.text((pc_x - 72 * scale, pc_y - 30 * scale), "ONLINE 24/7", fill=GLOW_YELLOW, font=FONT_XS)

    # PC Stand & Tower Box
    draw.polygon([(pc_x - 30 * scale, pc_y + 55 * scale), (pc_x + 30 * scale, pc_y + 55 * scale), (pc_x + 45 * scale, pc_y + 85 * scale), (pc_x - 45 * scale, pc_y + 85 * scale)], fill='#334155')
    draw.line([(pc_x - 45 * scale, pc_y + 85 * scale), (pc_x + 45 * scale, pc_y + 85 * scale)], fill=INK_WHITE, width=int(3 * scale))

    # Green lightning revive sparks
    for sp in range(3):
        rad = (t * 6 + sp * 2.1) % (2 * math.pi)
        sx = pc_x + math.cos(rad) * 115 * scale
        sy = pc_y + math.sin(rad) * 85 * scale
        draw.line([(pc_x, pc_y), (sx, sy)], fill=GLOW_GREEN, width=int(3 * scale))

    # 2. Center: Open Sleek Laptop
    lap_x = cx
    lap_y = cy + 70 * scale

    # Screen
    draw.rounded_rectangle((lap_x - 90 * scale, lap_y - 85 * scale, lap_x + 90 * scale, lap_y + 35 * scale), radius=int(10 * scale), fill='#1e293b', outline=INK_WHITE, width=int(3 * scale))
    draw.rectangle((lap_x - 75 * scale, lap_y - 72 * scale, lap_x + 75 * scale, lap_y + 24 * scale), fill='#090d16')
    draw.text((lap_x - 60 * scale, lap_y - 50 * scale), ">_ Laptop", fill=GLOW_CYAN, font=FONT_BOLD)
    draw.text((lap_x - 60 * scale, lap_y - 18 * scale), "Worker #2", fill='#94a3b8', font=FONT_XS)

    # Base keyboard
    draw.polygon([(lap_x - 120 * scale, lap_y + 60 * scale), (lap_x + 120 * scale, lap_y + 60 * scale), (lap_x + 90 * scale, lap_y + 35 * scale), (lap_x - 90 * scale, lap_y + 35 * scale)], fill='#334155')
    draw.line([(lap_x - 120 * scale, lap_y + 60 * scale), (lap_x + 120 * scale, lap_y + 60 * scale)], fill=INK_WHITE, width=int(3 * scale))

    # 3. Right: Cloud VPS (Cloud with rain of server nodes)
    vps_x = cx + 290 * scale
    vps_y = cy + 20 * scale

    # Cloud body
    cloud_pts = [
        (vps_x - 85 * scale, vps_y + 15 * scale),
        (vps_x - 95 * scale, vps_y - 25 * scale),
        (vps_x - 55 * scale, vps_y - 65 * scale),
        (vps_x, vps_y - 75 * scale),
        (vps_x + 55 * scale, vps_y - 65 * scale),
        (vps_x + 95 * scale, vps_y - 25 * scale),
        (vps_x + 85 * scale, vps_y + 25 * scale),
        (vps_x - 85 * scale, vps_y + 25 * scale)
    ]
    draw_smooth_curve(draw, cloud_pts, fill=INK_WHITE, width=int(4 * scale), closed=True, fill_color='#0284c7')
    draw.text((vps_x - 58 * scale, vps_y - 28 * scale), "[VPS Cloud]", fill='#ffffff', font=FONT_BOLD)

    # Server Rack Rack Box beneath cloud
    rack_box = (vps_x - 60 * scale, vps_y + 40 * scale, vps_x + 60 * scale, vps_y + 115 * scale)
    draw.rounded_rectangle(rack_box, radius=int(8 * scale), fill='#111827', outline=INK_WHITE, width=int(3 * scale))
    # Blinking server LEDs
    for s_i in range(3):
        sy = vps_y + 55 * scale + s_i * 22 * scale
        draw.line([(vps_x - 45 * scale, sy), (vps_x + 15 * scale, sy)], fill='#334155', width=int(4 * scale))
        led_col = GLOW_GREEN if math.sin(t * 14 + s_i) > 0 else '#ef4444'
        draw.ellipse((vps_x + 30 * scale, sy - 4 * scale, vps_x + 40 * scale, sy + 6 * scale), fill=led_col)

    # 4. Neon Fiber Cables connecting directly into each specific tab!
    # Home-PC tab is around x = 230, Laptop tab around x = 370, PC tab around x = 490
    connections = [
        ((pc_x, pc_y - 85 * scale), (230, 194), GLOW_GREEN),
        ((lap_x, lap_y - 85 * scale), (370, 194), GLOW_CYAN),
        ((vps_x, vps_y - 75 * scale), (490, 194), GLOW_YELLOW),
    ]
    for src_pt, tab_target, c_col in connections:
        mid_x = (src_pt[0] + tab_target[0]) // 2
        mid_y = (src_pt[1] + tab_target[1]) // 2 - 40 * scale
        pts = [src_pt, (mid_x, mid_y), tab_target]
        draw_smooth_curve(draw, pts, fill=c_col, width=int(5 * scale))

        # Pulse packet traveling up the cable
        pkt_t = (t * 2.2 + src_pt[0] * 0.01) % 1.0
        px = src_pt[0] * (1 - pkt_t) + tab_target[0] * pkt_t
        py = src_pt[1] * (1 - pkt_t) + tab_target[1] * pkt_t
        draw.ellipse((px - 8 * scale, py - 8 * scale, px + 8 * scale, py + 8 * scale), fill='#ffffff', outline=c_col, width=2)

def draw_dark_flurry_recommend(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders rapid anime flurry barrage of fists slamming repeatedly
    down onto the terminal [ RECOMMEND ] button with sparks and shockwaves!
    """
    # Button Box
    btn_w, btn_h = 360 * scale, 85 * scale
    bx = cx - btn_w/2
    by = cy + 40 * scale

    # Slam compression impact bounce
    impact = abs(math.sin(t * 24))
    by += impact * 8 * scale

    draw.rectangle((bx, by, bx + btn_w, by + btn_h), fill='#0066FF', outline='#60a5fa', width=int(4 * scale))
    bbox = draw.textbbox((0, 0), "[ BẤM RECOMMEND ]", font=FONT_TITLE)
    bw_text = bbox[2] - bbox[0]
    draw.text((cx - bw_text / 2, by + 22 * scale), "[ BẤM RECOMMEND ]", fill='#ffffff', font=FONT_TITLE)

    # Shockwave ripple circles from button impact
    if impact > 0.7:
        rip_r = int((impact - 0.7) * 90 * scale)
        draw.ellipse((cx - rip_r, (by + btn_h/2) - rip_r/2, cx + rip_r, (by + btn_h/2) + rip_r/2), outline=GLOW_YELLOW, width=int(3 * scale))

    # Flurry of 6 Anime Fists raining down
    fist_offsets = [
        (-120, -110, 0.0),
        (-40, -140, 0.3),
        (30, -115, 0.6),
        (110, -135, 0.9),
        (-80, -90, 0.45),
        (70, -85, 0.75),
    ]

    for fx_off, fy_off, f_delay in fist_offsets:
        f_t = (t * 6 + f_delay) % 1.0
        fist_x = cx + fx_off * scale
        fist_y = cy + fy_off * scale + f_t * 90 * scale

        # Speed motion trail lines behind each fist
        draw.line([(fist_x, fist_y - 65 * scale), (fist_x, fist_y - 15 * scale)], fill='#94a3b8', width=int(3 * scale))

        # Comic Fist Bean
        draw.ellipse((fist_x - 24 * scale, fist_y - 20 * scale, fist_x + 24 * scale, fist_y + 20 * scale), fill=SKIN, outline=INK_WHITE, width=int(3 * scale))
        # Knuckles
        for kx in [-14, -4, 6, 16]:
            draw.line([(fist_x + kx * scale, fist_y - 8 * scale), (fist_x + kx * scale, fist_y + 10 * scale)], fill=INK_DARK, width=int(2 * scale))

    # Spark bursts around button
    for sp_i in range(8):
        sp_ang = sp_i * 45 + (t * 80)
        sp_rad = math.radians(sp_ang)
        sp_dist = 110 * scale + (t * 80) % (40 * scale)
        sx = cx + math.cos(sp_rad) * sp_dist
        sy = by + math.sin(sp_rad) * (sp_dist * 0.4)
        draw.line([(cx, by + btn_h/2), (sx, sy)], fill=GLOW_YELLOW, width=int(3 * scale))

def draw_dark_exam_terminal(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders an exam test sheet formatted as a native terminal prompt
    with an animated yellow pencil frantically circling option (C) Recommend!
    """
    box_w, box_h = 920 * scale, 580 * scale
    bx = cx - box_w/2
    by = cy - box_h/2

    # Terminal Exam Container
    draw.rectangle((bx, by, bx + box_w, by + box_h), fill='#111827', outline=GLOW_CYAN, width=int(3 * scale))

    # Title Bar
    draw.rectangle((bx, by, bx + box_w, by + 55 * scale), fill='#1e293b')
    draw.text((bx + 25 * scale, by + 12 * scale), "[?] BÀI THI TRẮC NGHIỆM HITL (MÃ ĐỀ: 2026)", fill='#ffffff', font=FONT_BOLD)

    # Question text
    qy = by + 75 * scale
    draw.text((bx + 30 * scale, qy), "Câu 1: AI vừa xin quyền chạy script PowerShell 2,000 dòng.", fill=GLOW_YELLOW, font=FONT_BOLD)
    draw.text((bx + 30 * scale, qy + 40 * scale), "Bạn sẽ làm gì để đảm bảo đúng chuẩn Human-In-The-Loop?", fill='#94a3b8', font=FONT_REGULAR)

    # Options A, B, C
    options = [
        ("A", "Đọc kỹ từng dòng code (Mất 15 phút suy nghĩ)", False),
        ("B", "Từ chối và tự tay viết lại từ đầu", False),
        ("C", "Nhắm mắt bấm RECOMMEND cho nhanh! (99% Dev chọn)", True),
    ]

    opt_y = qy + 95 * scale
    circ_target = None

    for letter, opt_text, is_recommend in options:
        ob_box = (bx + 30 * scale, opt_y, bx + box_w - 30 * scale, opt_y + 68 * scale)
        bg_col = '#1e293b' if not is_recommend else '#172554'
        border_col = '#334155' if not is_recommend else '#3b82f6'

        draw.rectangle(ob_box, fill=bg_col, outline=border_col, width=int(2 * scale))

        # Circle indicator
        circ_cx = bx + 65 * scale
        circ_cy = opt_y + 34 * scale
        draw.ellipse((circ_cx - 18 * scale, circ_cy - 18 * scale, circ_cx + 18 * scale, circ_cy + 18 * scale), fill='#090d16', outline=INK_WHITE, width=int(2 * scale))
        draw.text((circ_cx - 8 * scale, circ_cy - 14 * scale), letter, fill='#ffffff', font=FONT_BOLD)

        draw.text((bx + 105 * scale, opt_y + 18 * scale), opt_text, fill='#ffffff' if is_recommend else '#94a3b8', font=FONT_BOLD if is_recommend else FONT_REGULAR)

        if is_recommend:
            circ_target = (circ_cx, circ_cy)

        opt_y += 85 * scale

    # Animated Yellow Pencil frantically circling (C)
    if circ_target:
        ccx, ccy = circ_target
        # Scribble multiple irregular circles
        scribble_pts = []
        for deg in range(0, 1080, 45):
            rad = math.radians(deg)
            r = (28 + math.sin(deg * 3) * 6) * scale
            scribble_pts.append((ccx + math.cos(rad) * r, ccy + math.sin(rad) * r))

        max_idx = int(min(len(scribble_pts) - 1, (t * 18) % len(scribble_pts)))
        for i in range(max_idx):
            draw.line([scribble_pts[i], scribble_pts[i+1]], fill='#facc15', width=int(4 * scale))

        # Pencil tip position
        tip_x, tip_y = scribble_pts[max_idx]
        pencil_len = 90 * scale
        draw.line([(tip_x, tip_y), (tip_x + pencil_len * 0.7, tip_y - pencil_len * 0.7)], fill='#facc15', width=int(8 * scale))
        draw.polygon([(tip_x, tip_y), (tip_x + 12 * scale, tip_y - 6 * scale), (tip_x + 6 * scale, tip_y - 12 * scale)], fill='#1e293b')

def draw_dark_slumped_dev(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders the exhausted slumped dev on a dark surface with a cute soul ghost floating away.
    """
    ground_y = cy + 120 * scale

    # Slumped Body
    body_pts = [
        (cx - 70 * scale, ground_y - 15 * scale),
        (cx - 30 * scale, ground_y - 65 * scale),
        (cx + 40 * scale, ground_y - 60 * scale),
        (cx + 80 * scale, ground_y - 15 * scale),
    ]
    draw_smooth_curve(draw, body_pts, fill=INK_WHITE, width=int(4 * scale), closed=True, fill_color=SHIRT)

    # Slippers kicked off to the sides
    draw.rounded_rectangle((cx - 105 * scale, ground_y - 15 * scale, cx - 65 * scale, ground_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK_WHITE, width=int(2 * scale))
    draw.rounded_rectangle((cx + 65 * scale, ground_y - 15 * scale, cx + 105 * scale, ground_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK_WHITE, width=int(2 * scale))

    # Head Resting flat on ground
    head_cx = cx + 5 * scale
    head_cy = ground_y - 75 * scale
    head_r = 45 * scale
    draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=SKIN, outline=INK_WHITE, width=int(3 * scale))

    # Tousled Hair covering top of head
    hair_pts = [
        (head_cx - head_r - 2 * scale, head_cy - 10 * scale),
        (head_cx - head_r, head_cy - 40 * scale),
        (head_cx - 20 * scale, head_cy - 55 * scale),
        (head_cx + 5 * scale, head_cy - 60 * scale),
        (head_cx + 25 * scale, head_cy - 52 * scale),
        (head_cx + head_r, head_cy - 35 * scale),
        (head_cx + head_r + 2 * scale, head_cy - 5 * scale),
        (head_cx + 25 * scale, head_cy - 20 * scale),
        (head_cx + 8 * scale, head_cy - 25 * scale),
        (head_cx - 15 * scale, head_cy - 22 * scale),
        (head_cx - 30 * scale, head_cy - 18 * scale)
    ]
    draw_smooth_curve(draw, hair_pts, fill=INK_WHITE, width=int(3 * scale), closed=True, fill_color='#1e293b')

    # Spiral Eyes (@ @)
    for ex in [head_cx - 18 * scale, head_cx + 18 * scale]:
        spiral_pts = []
        for deg in range(0, 540, 45):
            rad = math.radians(deg + t * 180)
            r = (deg / 540) * 12 * scale
            spiral_pts.append((ex + math.cos(rad) * r, head_cy - 4 * scale + math.sin(rad) * r))
        for sp in range(len(spiral_pts) - 1):
            draw.line([spiral_pts[sp], spiral_pts[sp+1]], fill='#1e293b', width=int(2 * scale))

    # Wobbly exhausted mouth
    draw.arc((head_cx - 12 * scale, head_cy + 12 * scale, head_cx + 12 * scale, head_cy + 30 * scale), start=0, end=180, fill='#ef4444', width=int(3 * scale))

    # Cute Little Soul Ghost Floating out of mouth up towards the sky
    ghost_y = head_cy - 50 * scale - ((t * 35 * scale) % (140 * scale))
    ghost_x = head_cx + 35 * scale + math.sin(t * 4) * 18 * scale
    gw = 42 * scale

    # Ghost body shape
    draw.ellipse((ghost_x - gw/2, ghost_y - gw/2, ghost_x + gw/2, ghost_y + gw/2), fill='#f8fafc', outline='#38bdf8', width=int(2 * scale))
    draw.polygon([(ghost_x - gw/2, ghost_y), (ghost_x + gw/2, ghost_y), (ghost_x, ghost_y + gw * 0.9)], fill='#f8fafc')
    draw.line([(ghost_x - gw/2, ghost_y), (ghost_x, ghost_y + gw * 0.9), (ghost_x + gw/2, ghost_y)], fill='#38bdf8', width=int(2 * scale))

    # Tiny ghost face
    draw.text((ghost_x - 14 * scale, ghost_y - 14 * scale), "^ _ ^", fill='#0284c7', font=FONT_XS)
    draw.text((ghost_x + gw/2 + 6 * scale, ghost_y - 8 * scale), "...", fill='#38bdf8', font=FONT_SM)
