import math
import random

def get_animated_robot(t=0.0):
    """
    Rich ASCII AI Robot with:
    - Spinning radar antenna: | / - \
    - Blinking & scanning eyes
    - Audio waveform / equalizer mouth
    - Real-time token counter & progress bar
    - 4-frame claw typing frenzy with keyboard sparks
    """
    # 1. Radar antenna
    radar_frames = ["|", "/", "-", "\\"]
    radar_char = radar_frames[int(t * 8) % 4]
    spark = "*" if int(t * 12) % 2 == 0 else "+"

    # 2. Eyes
    eye_cycle = math.sin(t * 8)
    if eye_cycle > 0.8:
        eyes = "-   -" # Blink
    elif eye_cycle < -0.5:
        eyes = ">   <" # Focus
    else:
        # Scanning left-right
        scan_pos = int((t * 6) % 3)
        if scan_pos == 0:
            eyes = "O   ."
        elif scan_pos == 1:
            eyes = "O   O"
        else:
            eyes = ".   O"

    # 3. Equalizer mouth
    mouth_frames = [
        "[ = = = ]",
        "[ : : : ]",
        "[ | : | ]",
        "[ = - = ]",
        "[ : | : ]",
    ]
    mouth = mouth_frames[int(t * 10) % len(mouth_frames)]

    # 4. Token progress bar
    tok = int(135000 + (t * 8800) % 65000)
    tok_pct = int((tok % 20000) / 20000 * 12)
    tok_bar = "█" * tok_pct + "░" * (12 - tok_pct)

    # 5. Claws & Keyboard sparks
    claw_frame = int(t * 14) % 4
    if claw_frame == 0:
        claw_l, claw_r = "\\==", "==/"
        kb_spark = "*   ."
    elif claw_frame == 1:
        claw_l, claw_r = "/==", "==\\"
        kb_spark = ".   *"
    elif claw_frame == 2:
        claw_l, claw_r = "v==", "==v"
        kb_spark = "* * *"
    else:
        claw_l, claw_r = "^==", "==^"
        kb_spark = " . . "

    lines = [
        f"            ({spark})",
        f"             {radar_char}",
        "        .--------.",
        f"       |[ {eyes} ]|",
        f"       | {mouth} |",
        "       '----------'",
        "      .-'----------'-.",
        "     / | TOKENS BURN: | \\",
        f"    =  | [{tok:,}]  |  =",
        f"    |  | [{tok_bar}] |  |",
        "     \\ |______________| /",
        f"     {claw_l}[ CLAUDE CODE ]{claw_r}",
        f"      |~ {kb_spark} KEYBOARD ~|",
        "      [__|_|_|_|_|_|_|_|]",
    ]
    return lines

def get_animated_stressed_dev(t=0.0):
    """
    Expressive Stressed Dev with:
    - Shaking hair & ear steam
    - Sliding sweat drops
    - Trembling mouth & knocking knees
    - Heartbeat / EKG pulse line
    """
    # Jitter tremor
    tremor = math.sin(t * 26)
    mouth = "O" if tremor > 0 else "o"
    knee = ">   <" if tremor > 0 else "<   >"

    # Sweat animation sliding down
    sweat_step = int(t * 6) % 4
    sw1 = ";" if sweat_step == 0 else ("." if sweat_step == 1 else " ")
    sw2 = ";" if sweat_step == 2 else ("." if sweat_step == 3 else " ")

    # EKG heartbeat pulse
    ekg_step = int(t * 10) % 5
    ekg_patterns = [
        "_/\___",
        "__/\__",
        "___/\_",
        "____/\\",
        "/\\____",
    ]
    ekg = ekg_patterns[ekg_step]
    bpm = 150 + int(math.sin(t * 5) * 20)

    # Hair bristling
    hair = "\\ \\  |  / /" if tremor > 0 else "/ /  |  \\ \\"

    lines = [
        f"    [BPM: {bpm} {ekg}]",
        f"         {hair}  {sw1}",
        "           .-----.",
        f"          / >   < \\  {sw2}",
        f"         |  (o_o)  | {sw1}",
        f"        / \\   {mouth}   / \\",
        "       /   '-----'   \\",
        "      / /|  HITL!  |\\ \\",
        "     * * | CANH AI | * *",
        "         '---------'",
        f"           {knee}      *run*",
        "          [===] [===]",
        "         (dep to ong)",
    ]
    return lines

def get_animated_tra_da_dev(t=0.0):
    """
    Relaxed Street Trà Đá Dev with:
    - Head gently bobbing
    - 4-frame rhythmic foot tapping ("nhịp giò")
    - Alternating thumb typing on phone
    - Pulsing heart notification
    """
    # 4-frame foot tap
    foot_frame = int(t * 12) % 4
    if foot_frame == 0:
        leg_l = "/_/"
        leg_r = "\\_|"
        tap_label = "*nhip gio*"
    elif foot_frame == 1:
        leg_l = "/_/"
        leg_r = "\\-/"
        tap_label = "*nhip gio...*"
    elif foot_frame == 2:
        leg_l = "/_/"
        leg_r = "\\_/"
        tap_label = "*tap tap!*"
    else:
        leg_l = "/_/"
        leg_r = "\\_|"
        tap_label = "*nhip deu*"

    # Phone typing thumbs
    thumb_frame = int(t * 8) % 2
    thumb_l = "." if thumb_frame == 0 else " "
    thumb_r = " " if thumb_frame == 0 else "."

    # Heart pulse
    heart = "<3" if int(t * 4) % 2 == 0 else ".."

    lines = [
        "          .-------.",
        "         /  _   _  \\",
        f"        |  ( ^ _ ^ ) |   <3 Chat voi ghe!",
        "         \\    -    /",
        "       .---'-----'---.",
        f"      /  |{thumb_l} [{heart}] {thumb_r}|  \\",
        "     *   |  PHONE  |   * (nhan tin claude)",
        "         '---------'",
        "          / /   \\ \\",
        f"         {leg_l}   {leg_r}   {tap_label}",
        "        [===]   [===]  (dep to ong)",
        "     =================== (ghe nhua Duy Tan)",
    ]
    return lines

def get_animated_tra_da_table(t=0.0):
    """
    Street Trà Đá Table with:
    - Vapor smoke rising and drifting
    - Ice cubes bobbing inside the glass
    - Plate of sunflower seeds with eaten shells accumulating
    - Red beer crate table
    """
    # Smoke vapor rising (3 lines of drifting particles)
    vapor_step = int(t * 6) % 4
    v_rows = [
        [" ~   ~   ~ ", "  ~   ~   ~", "   ~   ~  ~", "~   ~   ~  "],
        ["  ~   ~    ", "   ~   ~   ", "~   ~      ", " ~   ~     "],
        ["    ~      ", "     ~     ", "  ~        ", "   ~       "],
    ]
    s1 = v_rows[0][vapor_step]
    s2 = v_rows[1][vapor_step]

    # Ice cube bobbing
    ice_pos = int(t * 4) % 2
    if ice_pos == 0:
        ice_line1 = "|   \\  [ICE]|"
        ice_line2 = "|    \\      |"
        ice_line3 = "| [ICE\     |"
    else:
        ice_line1 = "| [ICE\     |"
        ice_line2 = "|    \\      |"
        ice_line3 = "|   \\  [ICE]|"

    # Sunflower seeds accumulating
    seed_count = min(8, int((t % 15) * 0.8))
    seeds = "o " * (8 - seed_count) + ". " * seed_count

    lines = [
        f"        {s2}      (khoi tra da lanh)",
        f"        {s1}",
        "       .-----------.",
        f"       {ice_line1}",
        f"       {ice_line2}     (coc tra da 5k)",
        f"       {ice_line3}",
        "       '-----------'",
        f"      ( {seeds})  (dia huong duong)",
        "    .=================.",
        "    |   [#]     [#]   |",
        "    |  KET BIA TRÀ ĐÁ |  (ke lam ban)",
        "    '================='",
    ]
    return lines

def get_animated_ecosystem(t=0.0):
    """
    Multi-Device Cluster with:
    - CRT PC with retro phosphor oscilloscope
    - Laptop with animated compiling progress bar
    - Cloud VPS with blinking server rack LEDs
    - Continuous data packet stream traveling along cables
    """
    # CRT screen oscillation
    crt_frames = ["~^~_~^~", "_~^~_~^", "^~_~^~_", "~_~^~_~"]
    crt_wave = crt_frames[int(t * 6) % 4]

    # Laptop build bar
    lap_step = int((t * 5) % 6)
    lap_bar = "=" * lap_step + ">" + " " * (5 - lap_step)

    # VPS LED blinkers
    led1 = "●" if int(t * 6) % 2 == 0 else "○"
    led2 = "○" if int(t * 6) % 2 == 0 else "●"
    led3 = "●" if int(t * 4) % 2 == 0 else "○"

    # Data packets traveling on cable
    cable_step = int((t * 12) % 6)
    pkt_chars = ["-", "-", "=", "=", ">", ">"]
    p_lead = "".join([pkt_chars[(i + cable_step) % 6] for i in range(24)])

    lines = [
        " [Home-PC]             [Laptop]             [Cloud-VPS]",
        " .------------.     .------------.            .-----.  ",
        f" |>{crt_wave}|     | [{lap_bar}] |          (  VPS  ) ",
        " | ONLINE 24/7|     |  Worker AI |         ( CLOUD #3) ",
        " '------------'     '------------'          '-------'  ",
        f"    / /  \\ \\       /==============\\         [ {led1} {led2} {led3} ]  ",
        "   [========]      \\______________/         [ # # # ]  ",
        "        |                  |                    |      ",
        f"        +===={p_lead}====+      ",
        "                           |                           ",
        "                 v v v v v v v v v v                   ",
        "        ======================================         ",
        "        >> CHUYỂN MÁY CHỈ BẰNG 1 CÁI TAB! <<           ",
        "        ======================================         ",
    ]
    return lines

def get_animated_chibi_overload(t=0.0):
    """
    Chibi Overloaded Dev with:
    - Rotating spiral / dizzy eyes
    - Steam blowing out of ears
    - Shaking face
    """
    eye_frames = ["@ @", "O o", "o O", "@ @"]
    cur_eyes = eye_frames[int(t * 8) % 4]

    steam_frames = [
        (" (~)", "(~) "),
        ("(~~)", "(~~)"),
        ("( ~)", "(~ )"),
        (" ( )", "( ) "),
    ]
    st_l, st_r = steam_frames[int(t * 10) % 4]

    lines = [
        f" {st_l}     {st_r}",
        "  \\ .-----. /",
        f"---|({cur_eyes})|---  (OVERLOAD!)",
        "   |   O   |",
        "   '-------'",
        "   (PANIC!)",
    ]
    return lines

def get_animated_flurry_barrage(t=0.0):
    """
    Anime Flurry Barrage (ORA ORA ORA style) punching Recommend button:
    - 6-frame multi-fist cycling
    - Recommend button visibly depressing and bouncing
    - Impact sparks
    """
    f_step = int(t * 18) % 6
    if f_step == 0:
        fists_top = "  ==O             O=="
        fists_mid = "         ==O         "
        btn = "| [ BẤM RECOMMEND ]   |"
        fists_bot = "  ==O             ==O"
    elif f_step == 1:
        fists_top = "       ==O     O==   "
        fists_mid = "  ==O             ==O"
        btn = "| [[BẤM RECOMMEND]]   |" # Button depressed!
        fists_bot = "         O==         "
    elif f_step == 2:
        fists_top = "  ==O*            *O=="
        fists_mid = "       *BAM! BAM!*   "
        btn = "| [**RECOMMEND**]     |"
        fists_bot = "   ==O           ==O "
    elif f_step == 3:
        fists_top = "         O==         "
        fists_mid = "  ==O             ==O"
        btn = "| [ BẤM RECOMMEND ]   |"
        fists_bot = "  ==O             O=="
    elif f_step == 4:
        fists_top = "   ==O           ==O "
        fists_mid = "         ==O*        "
        btn = "| [[BẤM RECOMMEND]]   |"
        fists_bot = "       ==O     O==   "
    else:
        fists_top = " *O==             ==O*"
        fists_mid = "       *CLICK!*      "
        btn = "| [ BẤM RECOMMEND ]   |"
        fists_bot = "  ==O             ==O"

    lines = [
        fists_top,
        fists_mid,
        "+---------------------+",
        btn,
        "+---------------------+",
        fists_bot,
    ]
    return lines

def get_animated_soul_ghost(t=0.0):
    """
    Soul ghost floating up with undulating sinusoidal tail
    """
    eye = "x_x" if int(t * 4) % 2 == 0 else "^_^"
    tail_step = int(t * 8) % 3
    if tail_step == 0:
        tail = "(  ~ ~ ~  )"
    elif tail_step == 1:
        tail = "(   ~ ~   )"
    else:
        tail = "( ~ ~ ~ ~ )"

    lines = [
        "          .---.",
        f"         ( {eye} )  <-- Linh hon bay len...",
        "        .'     '.",
        f"       {tail}",
        "        '-------'",
    ]
    return lines
