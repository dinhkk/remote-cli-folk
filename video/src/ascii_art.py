import math
from PIL import Image, ImageDraw, ImageFont

FONT_ASCII = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 24)
FONT_ASCII_SM = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 20)
FONT_ASCII_LG = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', 30)

def draw_ascii_block(draw, lines, x, y, font=FONT_ASCII, color='#f8fafc', line_height=28, color_rules=None):
    """
    Renders multi-line ASCII art with support for per-character or per-line coloring.
    """
    for i, line in enumerate(lines):
        ly = y + i * line_height
        if color_rules:
            # Color by rule if supplied
            c = color
            for prefix, col in color_rules:
                if prefix in line:
                    c = col
                    break
            draw.text((x, ly), line, fill=c, font=font)
        else:
            draw.text((x, ly), line, fill=color, font=font)

def get_ascii_robot(t=0.0):
    spark = "*" if (int(t * 8) % 2 == 0) else "+"
    blink = "O O" if (math.sin(t * 12) > 0) else "- -"
    tok = int(126000 + (t * 8500) % 50000)
    claw_l = "\\" if (int(t * 16) % 2 == 0) else "/"
    claw_r = "/" if (int(t * 16) % 2 == 0) else "\\"

    lines = [
        f"         ({spark})",
        "          |",
        "     .--------.",
        f"    |[ {blink}  ]|",
        "    |   ===  |",
        "    '--------'",
        "   .-'--------'-.",
        f"  / |TOKENS:     | \\",
        f" =  | [{tok:,}]|  =",
        f"  \\ |____________| /",
        f"   {claw_l}==[  CLAUDE  ]=={claw_r}",
        "   [__|_|_|_|_|_|_|__]",
    ]
    return lines

def get_ascii_stressed_dev(t=0.0):
    sweat = ";" if (int(t * 6) % 2 == 0) else " "
    tremor = math.sin(t * 26)
    mouth = "O" if tremor > 0 else "o"
    knee_l = ">" if tremor > 0 else "<"
    knee_r = "<" if tremor > 0 else ">"

    lines = [
        "      \\ \\  |  / /",
        "        .-----.",
        f"       / >   < \\ {sweat}",
        f"      |  (o_o)  |{sweat}",
        f"     / \\   {mouth}   / \\",
        "    /   '-----'   \\",
        "   / /|  HITL!  | \\ \\",
        "  *   | CANH AI |   *",
        "      '---------'",
        f"        {knee_l}     {knee_r}",
        "       [===] [===]",
    ]
    return lines

def get_ascii_tra_da_dev(t=0.0):
    tap = "/" if (int(t * 14) % 2 == 0) else "\\"
    heart = "<3" if (int(t * 4) % 2 == 0) else ".."

    lines = [
        "         .-----.",
        "        /       \\",
        "       |  (^_^)  |   <3 Chat voi ghe!",
        "        \\   =   /",
        "      .--'-----'--.",
        f"     / |  [ {heart} ] | \\",
        "    *  |  PHONE  |  *",
        "       '---------'",
        f"       / /     \\ \\",
        f"      /_/       {tap}_|  *nhip gio*",
        "     [===]     [===]  (dep to ong)",
        "   =================  (ghe nhua)",
    ]
    return lines

def get_ascii_tra_da_table(t=0.0):
    steam = "~" if (int(t * 6) % 2 == 0) else " "
    steam2 = " " if (int(t * 6) % 2 == 0) else "~"

    lines = [
        f"        {steam}   {steam2}    (khoi tra da)",
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
    return lines

def test():
    im = Image.new('RGB', (1080, 1920), '#090d16')
    draw = ImageDraw.Draw(im)

    draw_ascii_block(draw, get_ascii_robot(1.5), 60, 200, color='#4ade80')
    draw_ascii_block(draw, get_ascii_stressed_dev(1.5), 560, 200, color='#f87171')
    draw_ascii_block(draw, get_ascii_tra_da_dev(1.5), 60, 600, color='#38bdf8')
    draw_ascii_block(draw, get_ascii_tra_da_table(1.5), 560, 600, color='#facc15')

    im.save('video/preview_ascii_test.png')
    print("Saved video/preview_ascii_test.png")

if __name__ == '__main__':
    test()
