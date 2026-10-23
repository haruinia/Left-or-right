from fastapi.testclient import TestClient

from services.gateway.app import app


def test_answer_rendering_dependencies_are_served_with_binary_fonts():
    client = TestClient(app)
    for path, media in (
        ("/vendor/katex/katex.min.js", "javascript"),
        ("/vendor/katex/katex.min.css", "text/css"),
        ("/vendor/katex/fonts/KaTeX_Main-Regular.woff2", "font/woff2"),
        ("/vendor/highlight/highlight.min.js", "javascript"),
    ):
        response = client.get(path)
        assert response.status_code == 200, path
        assert media in response.headers["content-type"]
        assert len(response.content) > 100


def test_vendor_route_cannot_read_outside_the_vendor_directory():
    client = TestClient(app)
    assert client.get("/vendor/%2e%2e/modules/home.js").status_code == 404
