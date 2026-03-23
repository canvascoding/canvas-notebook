# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e3]:
    - generic [ref=e4]:
      - img "Canvas Logo" [ref=e5]
      - heading "Canvas Notebook" [level=1] [ref=e6]
    - generic [ref=e7]:
      - generic [ref=e8]:
        - generic [ref=e9]: Email
        - textbox "Email" [ref=e10]:
          - /placeholder: Enter email
          - text: admin@example.com
      - generic [ref=e11]:
        - generic [ref=e12]: Password
        - textbox "Password" [ref=e13]:
          - /placeholder: Enter password
          - text: change-me
      - button "Login" [ref=e14]
  - region "Notifications alt+T"
  - button "Open Next.js Dev Tools" [ref=e20] [cursor=pointer]:
    - img [ref=e21]
  - alert [ref=e24]
```