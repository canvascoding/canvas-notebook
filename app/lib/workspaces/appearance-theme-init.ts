/**
 * Applies the cached workspace appearance while the document is parsed.
 *
 * The client provider still refreshes this cache from the API afterwards.
 * Keeping this bootstrap self-contained lets it run before React hydrates,
 * preventing the default Canvas colours from flashing on a hard reload.
 */
export const workspaceAppearanceInitScript = `(function(){try{
  var path=window.location.pathname;
  if(/\\/(?:login|sign-in|sign-up|setup|onboarding)(?:\\/|$)/u.test(path))return;
  var workspaceId=localStorage.getItem('canvas.activeWorkspaceId');
  if(!workspaceId)return;
  var value=JSON.parse(localStorage.getItem('canvas.workspaceAppearance.'+workspaceId)||'null');
  if(!value||value.enabled!==true||typeof value.radiusPx!=='number'||!/^#[0-9a-f]{6}$/iu.test(value.backgroundColor)||!/^#[0-9a-f]{6}$/iu.test(value.textColor)||!/^#[0-9a-f]{6}$/iu.test(value.accentColor))return;
  var theme=localStorage.getItem('theme')||'light';
  var mode=theme==='system'?(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):theme;
  function rgb(hex){return {r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)};}
  function hex(color){function channel(value){return Math.round(Math.min(255,Math.max(0,value))).toString(16).padStart(2,'0');}return '#'+channel(color.r)+channel(color.g)+channel(color.b);}
  function mix(from,to,weight){var a=rgb(from),b=rgb(to),w=Math.min(1,Math.max(0,weight));return hex({r:a.r+(b.r-a.r)*w,g:a.g+(b.g-a.g)*w,b:a.b+(b.b-a.b)*w});}
  function luminance(color){var c=rgb(color);function linear(value){value=value/255;return value<=.03928?value/12.92:Math.pow((value+.055)/1.055,2.4);}return .2126*linear(c.r)+.7152*linear(c.g)+.0722*linear(c.b);}
  function contrast(first,second){var light=Math.max(luminance(first),luminance(second)),dark=Math.min(luminance(first),luminance(second));return (light+.05)/(dark+.05);}
  function best(background){return contrast('#111111',background)>=contrast('#ffffff',background)?'#111111':'#ffffff';}
  function readable(color,background,minimum){if(contrast(color,background)>=minimum)return color;var target=best(background);for(var step=1;step<=10;step+=1){var candidate=mix(color,target,step/10);if(contrast(candidate,background)>=minimum)return candidate;}return target;}
  var background=mode==='dark'?mix('#090c12',value.backgroundColor.toLowerCase(),.18):value.backgroundColor.toLowerCase();
  var foregroundSeed=mode==='dark'?mix('#f7f8fa',value.textColor.toLowerCase(),.12):value.textColor.toLowerCase();
  var foreground=readable(foregroundSeed,background,4.5),darkSurface=luminance(background)<.24;
  var card=mix(background,'#ffffff',darkSurface?.055:.72),primary=readable(value.accentColor.toLowerCase(),background,3),secondary=mix(background,foreground,darkSurface?.11:.07),muted=mix(background,foreground,darkSurface?.075:.055),mutedForeground=readable(mix(foreground,background,darkSurface?.28:.34),muted,4.5),accent=mix(background,primary,darkSurface?.24:.14),border=mix(background,foreground,darkSurface?.2:.16),sidebar=mix(background,primary,darkSurface?.055:.035);
  var fonts={'canvas-sans':\"var(--font-geist-sans), Arial, 'Liberation Sans', Helvetica, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif\",'humanist-sans':\"'Avenir Next', Avenir, 'Segoe UI', 'DejaVu Sans', 'Liberation Sans', Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif\",'editorial-serif':\"Georgia, Cambria, 'Liberation Serif', 'Times New Roman', Times, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', serif\",'classic-serif':\"Baskerville, 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Liberation Serif', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', serif\",'technical-mono':\"'SFMono-Regular', 'Cascadia Code', 'Roboto Mono', Consolas, 'Liberation Mono', 'Courier New', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', monospace\",'arial-sans':\"Arial, 'Liberation Sans', Helvetica, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif\",'verdana-sans':\"Verdana, 'DejaVu Sans', 'Liberation Sans', Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif\",'trebuchet-sans':\"'Trebuchet MS', 'Liberation Sans', Arial, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif\",'georgia-serif':\"Georgia, 'Liberation Serif', 'Times New Roman', Times, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', serif\",'times-serif':\"'Times New Roman', Times, 'Liberation Serif', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', serif\",'courier-mono':\"'Courier New', Courier, 'Liberation Mono', 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', monospace\"};
  var root=document.documentElement,style=root.style,tokens={'--app-font-sans':fonts[value.font]||fonts['canvas-sans'],'--radius':Math.min(16,Math.max(0,value.radiusPx))+'px','--background':background,'--foreground':foreground,'--card':card,'--card-foreground':foreground,'--popover':card,'--popover-foreground':foreground,'--primary':primary,'--primary-foreground':best(primary),'--secondary':secondary,'--secondary-foreground':foreground,'--muted':muted,'--muted-foreground':mutedForeground,'--accent':accent,'--accent-foreground':foreground,'--border':border,'--input':border,'--ring':primary,'--chart-1':primary,'--sidebar':sidebar,'--sidebar-foreground':foreground,'--sidebar-primary':primary,'--sidebar-primary-foreground':best(primary),'--sidebar-accent':accent,'--sidebar-accent-foreground':foreground,'--sidebar-border':border,'--sidebar-ring':primary};
  root.dataset.workspaceAppearance='true';root.dataset.workspaceAppearanceWorkspace=workspaceId;
  Object.keys(tokens).forEach(function(key){style.setProperty(key,tokens[key]);});
}catch(e){}})();`;
