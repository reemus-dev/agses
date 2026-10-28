Output assets/demo/agses.gif
Output .cache/demo/agses.txt

Set Shell "bash"
Set Width 1200
Set Height 740
Set FontFamily "RobotoMono Nerd Font"
Set FontSize 16
Set LineHeight 1.15
Set TypingSpeed 25ms
Set Framerate 24
Set Theme { "name": "reemus", "black": "#3d3d3d", "red": "#ff7178", "green": "#70cd82", "yellow": "#f6c260", "blue": "#65b3f6", "magenta": "#e090e4", "cyan": "#23d8dc", "white": "#e7e3e0", "brightBlack": "#a09c96", "brightRed": "#ff989a", "brightGreen": "#97e79b", "brightYellow": "#ffdf90", "brightBlue": "#8dcaff", "brightMagenta": "#f8b7ff", "brightCyan": "#6ceef1", "brightWhite": "#fffdf8", "background": "#121212", "foreground": "#faf9f6", "selection": "#4c3128", "cursor": "#fc7d54" }
Set Padding 28
Set Margin 36
Set MarginFill ".cache/demo/backdrop.png"
Set BorderRadius 12
Set CursorBlink false

Env PS1 "\n\[\e[38;2;160;156;150m\]\w\[\e[0m\] \[\e[38;2;252;125;84m\]❯\[\e[0m\] "
Env PS0 "\n"

Hide
Type `agses() { bun src/index.ts "$@"; }`
Enter
Type "clear"
Enter
Show

Type "agses sessions --all --limit 8"
Sleep 200ms
Enter
Sleep 1.2s

Type "agses outline 0205853e93805d --no-tools --first 8"
Sleep 200ms
Enter
Sleep 1.6s

Type "agses read 0205853e93805d --entry 56 | head -11"
Sleep 200ms
Enter
Sleep 2s

Type `agses search HSV --all --role user`
Sleep 200ms
Enter
Sleep 4s
