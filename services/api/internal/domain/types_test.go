package domain_test

import (
	"testing"

	"github.com/arkelythex/estado/services/api/internal/domain"
)

func TestFormatCents(t *testing.T) {
	cases := []struct {
		cents int64
		want  string
	}{
		{0, "0.00"},
		{5, "0.05"},
		{125075, "1250.75"},
		{210000, "2100.00"},
		{-5, "-0.05"},
	}
	for _, tc := range cases {
		if got := domain.FormatCents(tc.cents); got != tc.want {
			t.Fatalf("FormatCents(%d) = %q, want %q", tc.cents, got, tc.want)
		}
	}
}
