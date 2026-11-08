import math
import random
from PIL import Image, ImageDraw, ImageFont
from sketch_engine import sketch_line, sketch_rect, sketch_circle, sketch_bezier

WIDTH = 1080
HEIGHT = 1920

def test_draw(t=1.0, frame_idx=30):
    im = Image.new('RGB', (WIDTH, HEIGHT), (252, 252, 250))
    d = ImageDraw.Draw(im)

    boil = int(frame_idx // 3)

    # 1. Test Hand-drawn Doodle Dev sitting at Tra Da
    # Blue Stool (wobbly sketch legs and seat)
    stool_x, stool_y = 350, 950
    # Seat
    sketch_rect(d, (stool_x, stool_y, stool_x + 300, stool_y + 50), fill_color='#38bdf8', outline='#0f172a', width=6, seed=boil)
    # Stool legs
    sketch_line(d, (stool_x + 30, stool_y + 50), (stool_x - 10, stool_y + 260), fill='#0f172a', width=7, seed=boil)
    sketch_line(d, (stool_x + 70, stool_y + 50), (stool_x + 50, stool_y + 240), fill='#0f172a', width=6, seed=boil+1)
    sketch_line(d, (stool_x + 230, stool_y + 50), (stool_x + 250, stool_y + 240), fill='#0f172a', width=6, seed=boil+2)
    sketch_line(d, (stool_x + 270, stool_y + 50), (stool_x + 310, stool_y + 260), fill='#0f172a', width=7, seed=boil+3)

    # Dev sitting on stool
    # Tapping foot animation: foot oscillates up and down!
    foot_tap_y = int(math.sin(t * 12) * 12)
    foot_tap_ang = math.sin(t * 12) * 0.2

    # Left Leg (resting)
    sketch_bezier(d, (stool_x + 100, stool_y + 30), (stool_x + 60, stool_y + 140), (stool_x + 80, stool_y + 230), fill='#0f172a', width=8, seed=boil)
    # Right Leg (tapping rhythmically!)
    knee_x, knee_y = stool_x + 170, stool_y + 130 + foot_tap_y // 2
    ankle_x, ankle_y = stool_x + 190, stool_y + 225 + foot_tap_y
    sketch_bezier(d, (stool_x + 150, stool_y + 30), (knee_x, knee_y), (ankle_x, ankle_y), fill='#0f172a', width=8, seed=boil+4)

    # Yellow flip-flops (Dép tổ ong)
    # Left foot
    sketch_rect(d, (stool_x + 60, stool_y + 230, stool_x + 120, stool_y + 250), fill_color='#facc15', outline='#0f172a', width=4, seed=boil)
    # Right foot (tilted when tapping)
    sketch_rect(d, (ankle_x - 10, ankle_y, ankle_x + 50, ankle_y + 20), fill_color='#facc15', outline='#0f172a', width=4, seed=boil+5)

    # Torso (curved slouching spine)
    hip_x, hip_y = stool_x + 125, stool_y + 25
    shoulder_x, shoulder_y = hip_x - 20, hip_y - 140
    # Spine curve
    sketch_bezier(d, (hip_x, hip_y), (hip_x - 30, hip_y - 70), (shoulder_x, shoulder_y), fill='#0f172a', width=12, seed=boil)
    # T-shirt body
    sketch_rect(d, (shoulder_x - 35, shoulder_y, hip_x + 35, hip_y), fill_color='#bae6fd', outline='#0f172a', width=6, seed=boil)

    # Head (sketch circle with messy hair & smile)
    head_x, head_y = shoulder_x + 15, shoulder_y - 65
    head_bob = int(math.sin(t * 3) * 4)
    head_y += head_bob
    sketch_circle(d, (head_x, head_y), radius=45, fill_color='#ffedd5', outline='#0f172a', width=6, seed=boil)
    # Messy wavy hair (curves!)
    hair_pts = [
        (head_x - 42, head_y - 10),
        (head_x - 30, head_y - 45),
        (head_x - 10, head_y - 55),
        (head_x + 15, head_y - 50),
        (head_x + 35, head_y - 35),
        (head_x + 44, head_y - 5)
    ]
    for hp in range(len(hair_pts) - 1):
        sketch_line(d, hair_pts[hp], hair_pts[hp+1], fill='#0f172a', width=7, seed=boil+hp)
    # Spiky tufts
    sketch_line(d, (head_x - 20, head_y - 50), (head_x - 25, head_y - 70), fill='#0f172a', width=6, seed=boil)
    sketch_line(d, (head_x + 5, head_y - 53), (head_x + 10, head_y - 75), fill='#0f172a', width=6, seed=boil+1)

    # Eyes: relaxed curved smile eyes
    d.arc((head_x - 28, head_y - 12, head_x - 8, head_y + 8), start=0, end=180, fill='#0f172a', width=5)
    d.arc((head_x + 8, head_y - 12, head_x + 28, head_y + 8), start=0, end=180, fill='#0f172a', width=5)
    # Warm smile
    d.arc((head_x - 15, head_y + 10, head_x + 15, head_y + 30), start=0, end=180, fill='#0f172a', width=5)

    # Arms holding smartphone: Left and right arm bending into hands
    phone_x, phone_y = shoulder_x + 70, shoulder_y + 60
    # Left arm: shoulder -> elbow -> phone
    sketch_bezier(d, (shoulder_x - 20, shoulder_y + 15), (shoulder_x - 5, shoulder_y + 80), (phone_x, phone_y + 20), fill='#0f172a', width=7, seed=boil)
    # Right arm: shoulder -> elbow -> phone
    sketch_bezier(d, (shoulder_x + 30, shoulder_y + 15), (shoulder_x + 50, shoulder_y + 75), (phone_x + 35, phone_y + 20), fill='#0f172a', width=7, seed=boil+1)

    # Smartphone
    sketch_rect(d, (phone_x, phone_y - 25, phone_x + 45, phone_y + 40), fill_color='#0284c7', outline='#0f172a', width=4, seed=boil)
    # Thumbs actively tapping! (wiggling up and down)
    thumb_l = int(math.sin(t * 16) * 4)
    thumb_r = int(math.cos(t * 16) * 4)
    d.ellipse((phone_x + 4, phone_y - 5 + thumb_l, phone_x + 14, phone_y + 5 + thumb_l), fill='#ffedd5', outline='#0f172a', width=3)
    d.ellipse((phone_x + 28, phone_y - 5 + thumb_r, phone_x + 38, phone_y + 5 + thumb_r), fill='#ffedd5', outline='#0f172a', width=3)

    # Little floating chat heart / signal waves from phone
    wave_r = int((t * 30) % 25)
    d.arc((phone_x + 15 - wave_r, phone_y - 35 - wave_r, phone_x + 15 + wave_r, phone_y - 35 + wave_r), start=200, end=340, fill='#38bdf8', width=3)

    # Glass of Iced Tea beside stool
    tea_x, tea_y = stool_x + 380, stool_y + 100
    # Tapered sketch glass
    sketch_line(d, (tea_x, tea_y), (tea_x + 120, tea_y), fill='#0f172a', width=5, seed=boil)
    sketch_line(d, (tea_x + 120, tea_y), (tea_x + 95, tea_y + 170), fill='#0f172a', width=5, seed=boil+1)
    sketch_line(d, (tea_x + 95, tea_y + 170), (tea_x + 25, tea_y + 170), fill='#0f172a', width=5, seed=boil+2)
    sketch_line(d, (tea_x + 25, tea_y + 170), (tea_x, tea_y), fill='#0f172a', width=5, seed=boil+3)
    # Tea liquid
    d.polygon([(tea_x + 7, tea_y + 45), (tea_x + 113, tea_y + 45), (tea_x + 92, tea_y + 165), (tea_x + 28, tea_y + 165)], fill='#d97706')
    # Ice cubes floating
    sketch_rect(d, (tea_x + 25, tea_y + 60, tea_x + 60, tea_y + 95), fill_color='#fef08a', outline='#0f172a', width=3, seed=boil)
    sketch_rect(d, (tea_x + 65, tea_y + 80, tea_x + 100, tea_y + 115), fill_color='#fef08a', outline='#0f172a', width=3, seed=boil+1)
    # Straw
    sketch_line(d, (tea_x + 75, tea_y - 50), (tea_x + 50, tea_y + 155), fill='#ef4444', width=8, seed=boil)

    # Lemon slice on rim
    sketch_circle(d, (tea_x - 10, tea_y + 10), radius=22, fill_color='#facc15', outline='#0f172a', width=4, seed=boil)

    # Condensation droplets running down glass
    for drop_i, (dx, dy_base) in enumerate([(tea_x + 15, tea_y + 90), (tea_x + 105, tea_y + 120)]):
        drop_y = dy_base + int((t * 20 + drop_i * 30) % 50)
        d.ellipse((dx, drop_y, dx + 6, drop_y + 10), fill='#60a5fa')

    # Plate of sunflower seeds
    sketch_circle(d, (tea_x + 60, tea_y + 210), radius=45, fill_color='#e2e8f0', outline='#0f172a', width=4, seed=boil)
    for sx, sy in [(tea_x + 40, tea_y + 205), (tea_x + 60, tea_y + 195), (tea_x + 75, tea_y + 210), (tea_x + 55, tea_y + 220)]:
        d.ellipse((sx, sy, sx + 12, sy + 7), fill='#334155')

    im.save('video/test_sketch_sample.png')
    print("Saved video/test_sketch_sample.png")

if __name__ == '__main__':
    test_draw()
