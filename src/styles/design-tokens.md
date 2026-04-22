# BIST AI Trading Terminal — Design System v3

## Color Palette

### Primary Background
- **Deep Black** `#111111` - Main background (Onyx)
- **Darker** `#0a0a0a` - Deepest layer
- **Dark** `#1a1a1a` - Working background
- **Card** `rgba(26, 26, 26, 0.7)` - Card/panel base

### Text Colors
- **Primary** `#f5f5f5` (--t1) - High contrast text
- **Secondary** `#c0c0c0` (--t2) - Secondary info
- **Tertiary** `#808080` (--t3) - Subtle/muted
- **Muted** `#606060` - Further reduced contrast

### Accent Colors

#### Bullish (Buy/Positive)
- **Green** `#00d84f` - Primary positive signal
- **Green Glow** `rgba(0, 216, 79, 0.2)` - Glow effect
- **Green Dark** `#008c2e` - Hover state

#### Bearish (Sell/Negative)
- **Red** `#ff3b47` - Primary negative signal
- **Red Glow** `rgba(255, 59, 71, 0.2)` - Glow effect
- **Red Dark** `#cc0000` - Hover state

#### Information/Secondary
- **Blue** `#468fea` - Information, secondary actions
- **Blue Glow** `rgba(70, 143, 234, 0.2)` - Glow effect
- **Blue Dark** `#1e5ac8` - Hover state

#### Warning
- **Yellow** `#ffd60a` - Hold signal, warnings
- **Orange** `#ff5800` - Extreme alerts

#### Advanced Signals
- **Purple** `#a855f7` - AI/advanced features
- **Purple Glow** `rgba(168, 85, 247, 0.2)` - Glow effect

#### Primary Interactive (Cyan)
- **Cyan** `#00cccc` - Primary interactive element
- **Cyan Glow** `rgba(0, 204, 204, 0.25)` - Focus/hover
- **Cyan Dark** `#0099a3` - Inactive state

## Typography

### Font Families
- **Monospace**: `JetBrains Mono` - Code, data, numbers
- **Display**: `Space Grotesk` - Headings, labels
- **Fallback**: System fonts

### Font Sizes
- **Header (Logo)** `22px`
- **Title** `26px`
- **Heading 1** `18px`
- **Heading 2** `16px`
- **Heading 3** `13px` (default)
- **Label** `12px` - UI labels
- **Small** `11px` - Secondary info
- **Tiny** `9px` - Tertiary/meta

### Font Weights
- **Regular** `400`
- **Medium** `500`
- **Semibold** `600`
- **Bold** `700`
- **Extra Bold** `800`

## Spacing

### Standard Scale
- **xs** `4px`
- **sm** `8px`
- **md** `12px`
- **lg** `16px`
- **xl** `20px`
- **2xl** `24px`
- **3xl** `32px`

## Effects

### Shadows
- **Shadow** `0 4px 16px rgba(0, 0, 0, 0.5)`
- **Shadow LG** `0 12px 32px rgba(0, 0, 0, 0.6)`
- **Shadow XL** `0 20px 50px rgba(0, 0, 0, 0.7)`

### Glows
- **Green Glow** `0 0 20px rgba(0, 216, 79, 0.2)`
- **Red Glow** `0 0 20px rgba(255, 59, 71, 0.2)`
- **Cyan Glow** `0 0 20px rgba(0, 204, 204, 0.2)`

### Blur
- **Standard** `blur(16px)`
- **Heavy** `blur(24px)`

## Transitions

- **Fast** `0.15s ease-out` - Micro interactions
- **Normal** `0.3s cubic-bezier(0.4, 0, 0.2, 1)` - Standard
- **Slow** `0.5s cubic-bezier(0.4, 0, 0.2, 1)` - Emphasis

## Component Guidelines

### Interactive Elements
- Min touch target: **44x44px** (accessibility)
- Focus ring: **2px solid #00cccc**
- Hover brightness: `brightness(1.1)`
- Active transform: `translateY(-2px)`

### Signal Cards
- **BUY**: Green glow, can grow on hover
- **SELL**: Red glow, can grow on hover
- **HOLD**: Yellow glow, can grow on hover

### Inputs & Forms
- Focus border: **var(--cyan)**
- Focus shadow: `0 0 20px rgba(0, 204, 204, 0.15)`
- Placeholder opacity: **20%**

### Buttons
- Default: Gradient cyan-to-blue
- Primary CTA: Full width, uppercase
- Disabled opacity: **40%**

## Glass Morphism

### Recommended Structure
```css
background: var(--glass);
backdrop-filter: var(--blur);
border: 1px solid var(--border-bright);
border-radius: 12px;
box-shadow: var(--shadow-lg);
```

## Accessibility Features

### Keyboard Navigation
- Tab order follows DOM
- Focus rings visible (2px cyan outline)
- 2px outline offset for clarity

### Reduced Motion
- Animations disabled for `prefers-reduced-motion`
- Essential transitions still work

### Color Contrast
- Text on dark: 4.5:1+ ratio
- Interactive elements: 3:1+ ratio
- Status indicators tested for colorblind users

## Responsive Breakpoints

- **Large Desktop** `1100px` - 3-column layout
- **Desktop** `860px` - Tablet preparation
- **Tablet** `768px` - 1-column, bottom nav
- **Mobile** `480px` - Optimized touch targets

## Performance Notes

- CSS variables reduce bundle size
- Glassmorphism uses native CSS backdrop-filter
- Animations use GPU-accelerated transforms
- Custom scroll styling for consistency

## Browser Support

- Modern browsers with CSS Grid
- Backdrop-filter support (Chrome 76+, Safari 9+)
- CSS variables (IE 11 requires fallbacks)
- Smooth scrolling (graceful degradation)
