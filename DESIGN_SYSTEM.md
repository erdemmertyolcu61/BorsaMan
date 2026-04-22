# BIST AI Trading Terminal — Design System Implementation Guide

## Overview

This document outlines the complete design system modernization for BIST AI Trading Terminal v3. The system includes a sophisticated dark luxury theme, enhanced accessibility, and professional glassmorphism effects.

## Recent Updates (v3)

### 1. **Color Palette Modernization**

#### Key Changes
- **Background**: Changed from slate-900 to pure Onyx (#111111) for deeper, more premium feel
- **Primary Accent**: Upgraded to Strong Cyan (#00cccc) for more vibrant, modern interactive elements
- **Signal Colors**: Enhanced with deeper, more saturated tones:
  - Green: #00d84f (brighter, more energetic)
  - Red: #ff3b47 (modern red, better contrast)
  - Blue: #468fea (stronger blue energy)
  - Yellow: #ffd60a (clearer warning)
  - Orange: #ff5800 (emergency/extreme alerts)
  - Purple: #a855f7 (advanced features)

#### Design Inspiration
- **Trading Platforms**: Bloomberg Terminal, TradingView
- **Modern Fintech**: Robinhood, Kraken, Stripe
- **Gaming Interfaces**: Professional esports dashboards
- **Luxury Brands**: Apple, Tesla (dark elegance)

### 2. **Enhanced Glassmorphism**

```css
/* Base glass effect */
background: var(--glass);
backdrop-filter: var(--blur);
border: 1px solid var(--border-bright);
border-radius: 12px;
```

- Increased blur radius: 16px (more prominent effect)
- Refined opacity layers for depth perception
- Subtle highlights for elevation

### 3. **Accessibility Improvements**

#### Focus States
- All interactive elements have 2px cyan outline
- Sufficient color contrast (WCAG AA+)
- Touch targets minimum 44x44px
- Keyboard navigation fully supported

#### Motion & Animation
- Respects `prefers-reduced-motion` setting
- Smooth easing curves: `cubic-bezier(0.4, 0, 0.2, 1)`
- Essential animations only
- GPU-accelerated transforms

#### Screen Reader Support
- Semantic HTML maintained
- Aria labels for complex components
- Status live regions for signal updates

### 4. **Typography Enhancements**

#### Font Selection
- **JetBrains Mono**: Technical data, numbers (monospace)
- **Space Grotesk**: Headings, labels (geometric, modern)
- Fallback to system fonts for performance

#### Text Hierarchy
- Improved contrast ratios
- Clear size differentiation
- Consistent letter-spacing (1-2px for UI labels)

### 5. **Component Updates**

#### Signal Cards
- Dual-border effect with glow
- Hover expansion (stronger shadow)
- Text shadow for depth
- Color-coded for BUY/SELL/HOLD

```css
.sig-card.buy {
  border-color: var(--green);
  box-shadow: 0 0 30px var(--green-glow);
}

.sig-card.buy:hover {
  box-shadow: 0 0 40px var(--green-glow);
  border-color: #00ff66; /* Brighter on hover */
}
```

#### Buttons
- Gradient backgrounds for CTAs
- Subtle lift on hover
- Dynamic shadows with glow effects
- Disabled state: 40% opacity

#### Inputs
- Cyan focus border with glow
- Smooth background transition
- Clear placeholder text (20% opacity)
- Dark card background for contrast

### 6. **Responsive Design**

#### Breakpoints
- **1100px**: Desktop (3-column)
- **860px**: Wide tablet (2-column)
- **768px**: Tablet/Mobile (1-column, bottom nav)
- **480px**: Small mobile (optimized touch)

#### Mobile Optimizations
- Bottom navigation bar (PWA ready)
- Touch-friendly button sizes (44x44px min)
- Safe area support (iPhone notch, etc.)
- Prevents auto-zoom on input focus

### 7. **Glass Effects & Layers**

#### Depth Levels
1. **Background**: `#111111` (Level 0)
2. **Cards/Panels**: `rgba(26,26,26,0.7)` (Level 1)
3. **Elevated Surfaces**: `rgba(35,35,35,0.8)` (Level 2)
4. **Modals**: Heavy blur `24px` (Level 3)

#### Glow Effects
Applied to signal elements for emphasis:
```css
box-shadow: 0 0 20px rgba(0, 216, 79, 0.2); /* Green */
```

### 8. **Animation Library**

#### Transitions
- **Fast** (0.15s): Micro-interactions, hover effects
- **Normal** (0.3s): State changes, standard interactions
- **Slow** (0.5s): Emphasis, important updates

#### Keyframe Animations
- `float`: Aurora background (25s, infinite)
- `pulse`: Badge pulsing (2s, infinite)
- `spin`: Loading spinner (0.8s, linear)
- `load-pulse`: Progress bar (2s, infinite)
- `fadeIn`: Element appearance (0.3s, ease-out)
- `modalFadeIn`: Modal entrance (0.2s, ease-out)

### 9. **CSS Variables Usage**

All colors, shadows, and effects use CSS variables for:
- Easy theme switching
- Consistent color management
- Reduced bundle size
- Runtime updates capability

#### Common Variables to Use
```javascript
// In components
style={{
  color: 'var(--green)',
  boxShadow: 'var(--shadow-glow-green)',
  borderColor: 'var(--border-bright)',
  background: 'var(--glass)',
}}
```

### 10. **Dark Mode Implementation**

Currently deployed as default dark theme. Light mode can be added by creating alternate variable set:

```css
@media (prefers-color-scheme: light) {
  :root {
    --bg-deep: #f5f5f5;
    --t1: #111111;
    /* ... adjust colors ... */
  }
}
```

## Component Implementation Checklist

### Each Component Should Include
- [ ] Focus states (keyboard navigation)
- [ ] Hover effects (cursor feedback)
- [ ] Active states (click feedback)
- [ ] Disabled state (when applicable)
- [ ] Loading state (with spinner)
- [ ] Error state (with red coloring)
- [ ] Success state (with green coloring)
- [ ] Responsive sizing (mobile-friendly)
- [ ] Accessibility labels (aria-*)
- [ ] Touch targets (44x44px minimum)

## Color Usage Guidelines

### Buy/Positive Signals
- Use `var(--green)` for text/icons
- Use `var(--green2)` for backgrounds
- Use `var(--green-glow)` for shadows
- Border: `var(--green)` or `#00ff66` (active)

### Sell/Negative Signals
- Use `var(--red)` for text/icons
- Use `var(--red2)` for backgrounds
- Use `var(--red-glow)` for shadows
- Border: `var(--red)` or `#ff6b7a` (active)

### Information/Secondary
- Use `var(--blue)` for CTAs
- Use `var(--blue2)` for secondary backgrounds
- Use `var(--cyan)` for primary interactive

### Warnings
- Use `var(--yellow)` for holds/neutral
- Use `var(--orange)` for extreme alerts

## File Structure

```
src/
├── styles/
│   ├── globals.css          ← Main design system (updated)
│   └── design-tokens.md     ← Reference documentation
├── components/
│   ├── Header/
│   ├── Chart/
│   ├── Trades/
│   ├── Analyze/
│   ├── Portfolio/
│   └── AIAdvisor/
└── DESIGN_SYSTEM.md         ← This file
```

## Browser Support

### Required Features
- CSS Grid
- CSS Variables
- Backdrop Filter
- CSS Gradients
- Flexbox
- CSS Transitions

### Supported Browsers
- Chrome 76+
- Firefox 67+
- Safari 12+
- Edge 79+
- Mobile browsers (iOS 12+, Android 10+)

### Fallbacks
- Solid color fallbacks for gradients
- Darker backgrounds for browsers without backdrop-filter
- Polyfill for CSS variables in IE 11 (optional)

## Performance Considerations

### Optimization Techniques Used
1. **CSS Variables**: Reduced code repetition
2. **GPU Acceleration**: `transform` and `opacity` for animations
3. **Backdrop Filter**: Hardware-accelerated blur
4. **Lazy Loading**: Images and components
5. **Responsive Images**: Optimized for different devices

### Loading Metrics Target
- First Contentful Paint (FCP): < 1.5s
- Largest Contentful Paint (LCP): < 2.5s
- Cumulative Layout Shift (CLS): < 0.1
- Time to Interactive (TTI): < 3.5s

## Testing Checklist

### Visual Testing
- [ ] All colors render correctly
- [ ] Gradients display smoothly
- [ ] Shadows appear with appropriate depth
- [ ] Text contrast is readable
- [ ] Animations are smooth (60fps)

### Accessibility Testing
- [ ] Keyboard navigation works
- [ ] Focus rings are visible
- [ ] Screen reader reads content
- [ ] Color not only differentiator
- [ ] Touch targets are 44x44px+

### Responsive Testing
- [ ] Desktop (1920x1080+)
- [ ] Laptop (1440x900)
- [ ] Tablet (768x1024)
- [ ] Mobile (375x667, 412x915)
- [ ] iPhone notch/safe areas

### Browser Testing
- [ ] Chrome (latest)
- [ ] Firefox (latest)
- [ ] Safari (latest)
- [ ] Edge (latest)
- [ ] Mobile browsers

## Future Enhancements

### Planned for Next Release
1. **Custom Theme Builder**: Allow users to customize colors
2. **Light Mode**: Alternate light theme
3. **Accessibility Panel**: High contrast mode
4. **Animation Settings**: Reduce/disable animations
5. **Font Size Adjuster**: User preference scaling

### Experimental Features
1. **3D Card Effects**: CSS 3D transforms
2. **Advanced Gradients**: Mesh gradients
3. **Canvas Backgrounds**: Interactive aurora
4. **WebGL Effects**: High-end graphics

## Support & References

### Design Resources
- [Mobbin Design Inspiration](https://mobbin.com)
- [Framer Template Gallery](https://www.framer.com/marketplace)
- [Bloomberg Terminal UI](https://www.bloomberg.com/professional/product/terminal/)
- [TradingView Platform](https://www.tradingview.com)

### Technical References
- [MDN CSS Grid](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Grid_Layout)
- [CSS Tricks Flexbox Guide](https://css-tricks.com/snippets/css/a-guide-to-flexbox/)
- [Web.dev Performance](https://web.dev/performance/)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)

## Contact & Questions

For design system questions or improvements, please refer to the architecture documentation in `CLAUDE.md`.

---

**Last Updated**: April 2026  
**Version**: 3.0  
**Status**: Production Ready
