import math
from PIL import Image, ImageDraw, ImageFont
from anim_scenes import (
    draw_organic_dev, draw_animated_robot, draw_token_fire,
    draw_tra_da_table, draw_multi_device_ecosystem,
    draw_active_pencil_test, draw_spam_recommend_barrage,
    draw_overloaded_mind
)

WIDTH = 1080
HEIGHT = 1920

def test_render_all():
    # 1. Test Scene 1
    im1 = Image.new('RGB', (WIDTH, HEIGHT), (250, 250, 248))
    d1 = ImageDraw.Draw(im1)
    d1.text((100, 100), "SCENE 1: NGHỊCH LÝ AI & HITL", fill='#0f172a', font=ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44))
    draw_animated_robot(d1, 320, 680, scale=1.3, t=2.5)
    draw_organic_dev(d1, 800, 680, scale=1.3, pose='standing_stressed', t=2.5)
    draw_token_fire(d1, 540, 1100, scale=1.4, t=2.5)
    im1.save('video/preview_scene_1.png')
    print("Saved video/preview_scene_1.png")

    # 2. Test Scene 2
    im2 = Image.new('RGB', (WIDTH, HEIGHT), (250, 250, 248))
    d2 = ImageDraw.Draw(im2)
    d2.text((100, 100), "SCENE 2: TRÀ ĐÁ VỈA HÈ", fill='#0f172a', font=ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44))
    draw_organic_dev(d2, 400, 850, scale=1.4, pose='sitting', t=3.2)
    draw_tra_da_table(d2, 750, 850, scale=1.3, t=3.2)
    im2.save('video/preview_scene_2.png')
    print("Saved video/preview_scene_2.png")

    # 3. Test Scene 3
    im3 = Image.new('RGB', (WIDTH, HEIGHT), (250, 250, 248))
    d3 = ImageDraw.Draw(im3)
    d3.text((100, 100), "SCENE 3: HỒI SINH MÁY CŨ & VPS", fill='#0f172a', font=ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44))
    draw_multi_device_ecosystem(d3, 540, 800, scale=1.3, t=1.8)
    im3.save('video/preview_scene_3.png')
    print("Saved video/preview_scene_3.png")

    # 4. Test Scene 5
    im5 = Image.new('RGB', (WIDTH, HEIGHT), (250, 250, 248))
    d5 = ImageDraw.Draw(im5)
    d5.text((100, 100), "SCENE 5: PHÂN MẢNH & RECOMMEND", fill='#0f172a', font=ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44))
    draw_overloaded_mind(d5, 540, 520, scale=1.3, t=3.5)
    draw_spam_recommend_barrage(d5, 540, 1150, scale=1.2, t=3.5)
    im5.save('video/preview_scene_5.png')
    print("Saved video/preview_scene_5.png")

    # 5. Test Scene 6
    im6 = Image.new('RGB', (WIDTH, HEIGHT), (250, 250, 248))
    d6 = ImageDraw.Draw(im6)
    d6.text((100, 100), "SCENE 6: BÀI THI TRẮC NGHIỆM", fill='#0f172a', font=ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44))
    draw_active_pencil_test(d6, 540, 750, scale=1.2, t=1.5)
    draw_organic_dev(d6, 540, 1450, scale=1.1, pose='dizzy_slumped', t=2.0)
    im6.save('video/preview_scene_6.png')
    print("Saved video/preview_scene_6.png")

if __name__ == '__main__':
    test_render_all()
