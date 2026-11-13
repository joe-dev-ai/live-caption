// Plain Ctrl+C copies the selected captions. The overlay never has keyboard
// focus, so the app borrows Ctrl+C as a global hotkey, but only while the
// pointer is over the overlay and caption text is selected. As soon as either
// stops, Ctrl+C goes back to the program in front (Chrome, Jump Desktop…).

export class CopyKey {
  private readonly setBorrowed: (borrowed: boolean) => void;
  private hovering = false;
  private selected = false;
  private borrowed = false;

  constructor(setBorrowed: (borrowed: boolean) => void) {
    this.setBorrowed = setBorrowed;
  }

  /** The pointer entered (true) or left (false) the overlay. */
  hover(on: boolean): void {
    this.hovering = on;
    this.update();
  }

  /** Caption text is selected (true) or not (false). */
  selection(on: boolean): void {
    this.selected = on;
    this.update();
  }

  private update(): void {
    const borrow = this.hovering && this.selected;
    if (borrow === this.borrowed) return;
    this.borrowed = borrow;
    this.setBorrowed(borrow);
  }
}
