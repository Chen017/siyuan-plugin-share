---
id: supported
title: Supported Functions (Curated Regression Suite)
---
# KaTeX Supported Functions Regression Test

This document provides a comprehensive test suite of mathematical syntax supported by the local KaTeX 0.16.9 engine in both web reader and PDF export.

## 1. Accents

| Accent | Syntax | Accent | Syntax |
|:---|:---|:---|:---|
| $a'$ | `a'` | $\tilde{a}$ | `\tilde{a}` |
| $a''$ | `a''` | $\widetilde{ac}$ | `\widetilde{ac}` |
| $a^{\prime}$ | `a^{\prime}` | $\utilde{AB}$ | `\utilde{AB}` |
| $\acute{a}$ | `\acute{a}` | $\vec{F}$ | `\vec{F}` |
| $\bar{y}$ | `\bar{y}` | $\overleftarrow{AB}$ | `\overleftarrow{AB}` |
| $\breve{a}$ | `\breve{a}` | $\overrightarrow{AB}$ | `\overrightarrow{AB}` |
| $\check{a}$ | `\check{a}` | $\overleftharpoon{ac}$ | `\overleftharpoon{ac}` |
| $\dot{a}$ | `\dot{a}` | $\overleftrightarrow{AB}$ | `\overleftrightarrow{AB}` |
| $\ddot{a}$ | `\ddot{a}` | $\overbrace{AB}$ | `\overbrace{AB}` |
| $\grave{a}$ | `\grave{a}` | $\underbrace{AB}$ | `\underbrace{AB}` |
| $\hat{\theta}$ | `\hat{\theta}` | $\overline{AB}$ | `\overline{AB}` |
| $\widehat{ac}$ | `\widehat{ac}` | $\underline{AB}$ | `\underline{AB}` |

### Accent functions inside `\text{…}`

| Symbol | Syntax | Symbol | Syntax |
|:---|:---|:---|:---|
| $\text{\'{a}}$ | `\'{a}` | $\text{\~{a}}$ | `\~{a}` |
| $\text{\`{a}}$ | `\`{a}` | $\text{\={a}}$ | `\={a}` |
| $\text{\^{a}}$ | `\^{a}` | $\text{\"{a}}$ | `\"{a}` |
| $\text{\.{a}}$ | `\.{a}` | $\text{\u{a}}$ | `\u{a}` |

## 2. Delimiters

| Delimiter | Syntax | Delimiter | Syntax |
|:---|:---|:---|:---|
| $(~)$ | `( )` | $\lparen~\rparen$ | `\lparen \rparen` |
| $[~]$ | `[ ]` | $\lbrack~\rbrack$ | `\lbrack \rbrack` |
| $\{ \}$ | `\{ \}` | $\lbrace \rbrace$ | `\lbrace \rbrace` |
| $\langle~\rangle$ | `\langle \rangle` | $\lgroup~\rgroup$ | `\lgroup \rgroup` |
| $\lceil~\rceil$ | `\lceil \rceil` | $\lfloor~\rfloor$ | `\lfloor \rfloor` |
| $\vert$ | `\vert` | $\Vert$ | `\Vert` |
| $\lvert~\rvert$ | `\lvert \rvert` | $\lVert~\rVert$ | `\lVert \rVert` |
| $\uparrow$ | `\uparrow` | $\downarrow$ | `\downarrow` |
| $\Uparrow$ | `\Uparrow` | $\Downarrow$ | `\Downarrow` |
| $\backslash$ | `\backslash` | $/$ | `/` |

### Delimiter Sizing

$\left(\LARGE{AB}\right)$

$( \big( \Big( \bigg( \Bigg($

$\left[ \frac{a}{b} \right] \quad \left\{ \frac{a}{b} \right\} \quad \left\langle \frac{a}{b} \right\rangle \quad \left| \frac{a}{b} \right| \quad \left\| \frac{a}{b} \right\|$

## 3. Environments

### Matrix and Array Environments (Inline / Table)

| Preview | Environment Type |
|:---|:---|
| $\begin{matrix} a & b \\ c & d \end{matrix}$ | Plain Matrix (`matrix`) |
| $\begin{pmatrix} a & b \\ c & d \end{pmatrix}$ | Parentheses Matrix (`pmatrix`) |
| $\begin{bmatrix} a & b \\ c & d \end{bmatrix}$ | Bracket Matrix (`bmatrix`) |
| $\begin{vmatrix} a & b \\ c & d \end{vmatrix}$ | Determinant (`vmatrix`) |
| $\begin{Vmatrix} a & b \\ c & d \end{Vmatrix}$ | Norm Matrix (`Vmatrix`) |
| $\begin{Bmatrix} a & b \\ c & d \end{Bmatrix}$ | Braces Matrix (`Bmatrix`) |
| $\begin{smallmatrix} a & b \\ c & d \end{smallmatrix}$ | Small Matrix (`smallmatrix`) |
| $x = \begin{cases} a &\text{if } b \\ c &\text{if } d \end{cases}$ | Cases (`cases`) |
| $\begin{rcases} a &\text{if } b \\ c &\text{if } d \end{rcases} \implies \text{result}$ | Right Cases (`rcases`) |
| $\def\arraystretch{1.5}\begin{array}{c:c:c} a & b & c \\ \hline d & e & f \\ \hdashline g & h & i \end{array}$ | Array with horizontal & vertical rules |

### Display-Mode Multi-line Environments (Standalone Blocks)

1. Equation with split:
$$\begin{equation}\begin{split}a &=b+c\\&=e+f\end{split}\end{equation}$$

2. Aligned equations:
$$\begin{align} a&=b+c \\ d+e&=f \end{align}$$

3. Gathered equations:
$$\begin{gather} a=b \\ e=b+c \end{gather}$$

4. Aligned at multiple points:
$$\begin{alignat}{2}10&x+&3&y=2\\3&x+&13&y=4\end{alignat}$$

5. Commutative diagram (CD):
$$\begin{CD}A @>a>> B \\@VbVV @AAcA\\C @= D\end{CD}$$

6. Sum with subarray:
$$\sum_{\begin{subarray}{l} i\in\Lambda\\ 0<j<n\end{subarray}} x_{ij}$$

## 4. Letters and Unicode

### Greek Letters

$\Alpha \Beta \Gamma \Delta \Epsilon \Zeta \Eta \Theta \Iota \Kappa \Lambda \Mu \Nu \Xi \Omicron \Pi \Rho \Sigma \Tau \Upsilon \Phi \Chi \Psi \Omega$

$\alpha \beta \gamma \delta \epsilon \varepsilon \zeta \eta \theta \vartheta \iota \kappa \lambda \mu \nu \xi \pi \varpi \rho \varrho \sigma \varsigma \tau \upsilon \phi \varphi \chi \psi \omega$

### Other Letters and Direct Input

$\partial \nabla \Im \Re \aleph \beth \hbar \ell \wp \eth \Game \Bbbk \Finv$

Direct unicode math: $∂ ∇ ℑ ℵ ℏ ð − ∗$

Unicode subscripts and superscripts: $A²⁺³ = A^{2+3}$, $x₁ + y₂$

### Unicode Mathematical Alphanumeric Font Ranges

| Style | Sample |
|:---|:---|
| Bold | $\mathbf{A-Z \ a-z \ 0-9}$ |
| Italic | $\mathit{A-Z \ a-z}$ |
| Double-struck (Blackboard) | $\mathbb{R} \quad \mathbb{C} \quad \mathbb{Z} \quad \mathbb{N} \quad \mathbb{Q}$ |
| Sans serif | $\mathsf{A-Z \ a-z \ 0-9}$ |
| Fraktur | $\mathfrak{A-Z \ a-z}$ |
| Script / Calligraphic | $\mathcal{A-Z} \quad \mathscr{A-Z}$ |

## 5. Layout, Annotation, and Spacing

### Annotations and Cross-outs

$\cancel{5} \quad \bcancel{5} \quad \xcancel{ABC} \quad \boxed{\pi = \frac{c}{d}} \quad \phase{-78^\circ}$

### Equation Tags

$$\tag{1.1} x + y^{2x} = z$$

$$\tag*{[A]} F = ma$$

### Vertical Layout and Accents

$x_n \quad e^x \quad \stackrel{!}{=} \quad \overset{\text{def}}{=} \quad \underset{x \to 0}{=} \quad {a \atop b} \quad a\raisebox{0.25em}{$b$}c$

$$\sum_{\substack{0<i<m \\ 0<j<n}} a_{ij}$$

### Overlap and Spacing

${=}\mathllap{/\,} \quad \mathrlap{\,/}{=} \quad \sqrt{\smash[b]{y}} \quad \displaystyle\sum_{\mathclap{1\le i\le j\le n}} x_{ij}$

Spacing units: $a\,b \quad a\:b \quad a\;b \quad a\quad b \quad a\qquad b \quad a\!b$

Phantom sizing: $A\phantom{XXX}B \quad A\hphantom{XXX}B \quad A\vphantom{\frac{1}{2}}B$

## 6. Logic, Sets, and Macros

$\forall x \in \mathbb{R}, \quad \exists y : \quad y > x \land y \neq x$

$A \subset B \quad A \subseteq B \quad A \cup B \quad A \cap B \quad A \setminus B \quad \emptyset \quad \complement_U(A)$

$P \implies Q \quad P \impliedby Q \quad P \iff Q \quad \neg P$

Self-contained macro definition:
$\def\square#1{#1^2} \square{x} + \square{y} = \square{z}$

## 7. Operators and Calculus

### Big Operators with Limits

$$\sum_{i=1}^n i = \frac{n(n+1)}{2} \qquad \prod_{k=1}^m k = m!$$

$$\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2} \qquad \iint_D f(x,y)\,dx\,dy \qquad \oint_C \vec{F}\cdot d\vec{r}$$

$\coprod_{i\in I} X_i \qquad \bigoplus_{k=1}^n V_k \qquad \bigotimes_{j=1}^m W_j \qquad \bigcap_{s\in S} A_s \qquad \bigcup_{t\in T} B_t$

### Binary Operators and Relations

$+ \quad - \quad \times \quad \div \quad \pm \quad \mp \quad \cdot \quad \circ \quad \ast \quad \bullet$

$\oplus \quad \ominus \quad \otimes \quad \oslash \quad \odot \quad \wedge \quad \vee \quad \cap \quad \cup$

$x \equiv y \pmod{m} \qquad a \le b \quad a \ge b \quad a \ll b \quad a \gg b \quad a \approx b \quad a \sim b$

### Fractions, Binomials, and Radicals

$\frac{a}{b} \quad \dfrac{a}{b} \quad \tfrac{a}{b} \quad {a \over b} \quad \binom{n}{k} \quad \dbinom{n}{k} \quad \tbinom{n}{k}$

$$\cfrac{1}{1 + \cfrac{1}{2 + \cfrac{1}{3 + x}}}$$

$\sqrt{x} \qquad \sqrt[3]{a+b} \qquad \sqrt{\frac{1}{1+\frac{1}{x}}}$

### Math Functions

$\sin(x) \quad \cos(x) \quad \tan(x) \quad \arcsin(x) \quad \ln(x) \quad \log_{10}(x) \quad \exp(x)$

$\lim_{x \to 0} \frac{\sin x}{x} = 1 \qquad \max_{x \in [a,b]} f(x) \qquad \min(u, v) \qquad \det(A) \qquad \gcd(a, b)$

## 8. Arrows and Extensible Arrows

Representative standard arrows:
$\leftarrow \quad \rightarrow \quad \leftrightarrow \quad \Leftarrow \quad \Rightarrow \quad \Leftrightarrow \quad \mapsto \quad \hookleftarrow \quad \hookrightarrow$

Extensible arrows with upper and lower annotations:
$\xleftarrow{abc} \qquad \xrightarrow[under]{over} \qquad \xLeftarrow{T} \qquad \xRightarrow{F} \qquad \xleftrightarrow{\text{long}} \qquad \xmapsto{n \to \infty}$

## 9. Bra-Ket Notation

$\bra{\phi} \qquad \ket{\psi} \qquad \braket{\phi | \psi} \qquad \Bra{\phi} \qquad \Ket{\psi} \qquad \Braket{\phi | \hat{H} | \psi}$

## 10. Styles, Colors, Sizes, and Symbols

### Colors and Boxes

$\color{blue}{F = ma} \qquad \textcolor{red}{E = mc^2} \qquad \colorbox{yellow}{$a^2 + b^2 = c^2$} \qquad \fcolorbox{red}{aqua}{$x + y$}$

### Sizes

{\tiny Tiny} $\quad$ {\small Small} $\quad$ {\normalsize Normal} $\quad$ {\large Large} $\quad$ {\Large Larger} $\quad$ {\LARGE VeryLarge} $\quad$ {\huge Huge} $\quad$ {\Huge Giant}

### Symbols and Units

$\infty \quad \nabla \quad \partial \quad \angle \quad \triangle \quad \square \quad \Box \quad \checkmark \quad \dag \quad \ddag \quad \star \quad \dots \quad \cdots \quad \vdots \quad \ddots$

$\rule{1em}{1em} \qquad \rule{18mu}{18mu} \qquad \rule{20pt}{2pt}$
